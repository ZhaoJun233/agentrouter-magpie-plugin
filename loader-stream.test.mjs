import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRouterAuthPlugin } from './index.mjs';

const encoder = new TextEncoder();
const message = 'Your requests to gpt-6-astra for gpt-6-astra in example-region have exceeded token rate limit.';
const cap = { message, type: 'api_error' };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const fail = frame('error', cap);
const created = frame('response.created', { type: 'response.created', response: { output: [] } });
const sse = (body, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...extra } });
async function load(response) {
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    assert.equal(++calls, 1, "loader must never retry an upstream request");
    return response;
  };
  try {
    const p = await AgentRouterAuthPlugin();
    const l = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    return await l.fetch('https://example.invalid/v1/responses', { method: 'POST', body: '{}' });
  } finally { globalThis.fetch = old; }
}

test('Whitelisted numeric upstream statuses in explicit errors replace false HTTP200 success', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    for (const field of ['status', 'status_code', 'code']) {
      const error = { [field]: status, message: 'upstream fixture failure' };
      const r = await load(sse(frame('error', { error })));
      assert.equal(r.status, status, field + '=' + status);
      assert.equal((await r.json()).error.type, status === 429
        ? 'agent_router_upstream_rate_limit' : 'agent_router_upstream_error');
      assert.equal(r.headers.get('retry-after'), null);
    }
  }
});

test('Whitelisted transient codes map conservatively and retain Retry-After', async () => {
  for (const [code, status, type] of [
    ['rate_limit_exceeded', 429, 'agent_router_upstream_rate_limit'],
    ['server_error', 500, 'agent_router_upstream_error'],
    ['overloaded_error', 503, 'agent_router_upstream_busy'],
    ['high_demand', 503, 'agent_router_upstream_busy'],
  ]) {
    for (const field of ['code', 'type']) {
      const r = await load(sse(frame('response.failed', { response: { error: { [field]: code, message: 'fixture error' } } }), { 'retry-after': '17' }));
      assert.equal(r.status, status, field + '=' + code);
      assert.equal((await r.json()).error.type, type);
      assert.equal(r.headers.get('retry-after'), '17');
    }
  }
});

test('Business errors take precedence over transient status and wording', async () => {
  for (const business of [
    { code: 'invalid_api_key' }, { type: 'authentication_error' }, { code: 'permission_denied' },
    { type: 'insufficient_quota' }, { code: 'insufficient_balance' }, { code: 'content_policy_violation' },
    { message: 'Your account balance is insufficient' }, { message: 'Daily quota exceeded' },
  ]) {
    const error = { status: 429, code: 'server_error', message: 'fixture error', ...business };
    const text = frame('error', { error });
    const r = await load(sse(text));
    assert.equal(r.status, 200, JSON.stringify(business));
    assert.equal(await r.text(), text);
  }
});

test('Nested error envelopes retain outer status and veto business markers at every layer', async () => {
  const transient = { status: 503, error: { message: 'fixture upstream failed' } };
  for (const response of [sse(frame('error', transient)), new Response(JSON.stringify(transient), { headers: { 'content-type': 'application/json' } })]) {
    const r = await load(response);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.type, 'agent_router_upstream_error');
  }
  for (const envelope of [
    { code: 'insufficient_quota', error: { code: 'server_error' } },
    { error: { code: 'insufficient_quota', message: JSON.stringify({ code: 'server_error', message: 'fixture' }) } },
    { response: { error: { type: 'permission_denied', status: 503 } } },
  ]) {
    const text = frame('error', envelope);
    const r = await load(sse(text));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
  }
});

test('Unknown status, malformed numeric strings and detail-less failures stay byte-identical', async () => {
  for (const error of [{}, { status: 200 }, { status: 418 }, { status: '429x' }, { status: ' 429' }, { status: '0503' }, { code: 'new_error' }, { message: 'busy' }]) {
    const text = frame('error', { error });
    const r = await load(sse(text));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
  }
});

test('Wire HTTP200 event:error with api_error payload becomes explicit 429', async () => {
  const r = await load(sse(fail));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  const j = await r.json();
  assert.equal(j.error.type, 'agent_router_token_rate_limit');
  assert.equal(j.error.upstream, message);
});

test('Nested JSON message in response.failed after metadata is recognized', async () => {
  const data = { type: 'response.failed', response: { error: { message: JSON.stringify(cap) } } };
  const r = await load(sse(created + frame('response.failed', data)));
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.upstream, message);
});

test('A JSON error in HTTP200 is recognized without matching successful output text', async () => {
  const r = await load(new Response(JSON.stringify({ error: cap }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(r.status, 429);
  const ok = JSON.stringify({ output: [{ text: message }] });
  const success = await load(new Response(ok, { headers: { 'content-type': 'application/json' } }));
  assert.equal(success.status, 200);
  assert.equal(await success.text(), ok);
});

test('Rate errors preserve upstream wait and request id, remove stale entity metadata', async () => {
  const r = await load(sse(fail, { 'retry-after': '120', 'x-request-id': 'req-fixture', 'content-length': '999', 'content-encoding': 'gzip', etag: 'old' }));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '120');
  assert.equal(r.headers.get('x-request-id'), 'req-fixture');
  for (const h of ['content-length', 'content-encoding', 'etag']) assert.equal(r.headers.get(h), null);
});

test('An HTTP-date Retry-After is retained verbatim', async () => {
  const wait = 'Wed, 04 Nov 2026 08:00:00 GMT';
  const r = await load(sse(fail, { 'retry-after': wait }));
  assert.equal(r.headers.get('retry-after'), wait);
});

test('Explicit streamed content refusal becomes 400, not 429', async () => {
  const r = await load(sse(frame('error', { error: { code: 'content-blocked', message: 'request id: ABC123' } })));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('retry-after'), null);
  assert.equal((await r.json()).error.code, 'content-blocked');
});

test('Tiny byte chunks, UTF8 comments, CRLF and metadata cannot hide an early failure', async () => {
  const text = (': 中文🪶\n\n' + created + fail).replaceAll('\n', '\r\n');
  const bytes = encoder.encode(text);
  let i = 0;
  const r = await load(sse(new ReadableStream({
    pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); },
  })));
  assert.equal(r.status, 429);
});

test('A completed empty output with zero input/output is 502, never a fabricated cap', async () => {
  const r = await load(sse(created + frame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } } })));
  assert.equal(r.status, 502);
  assert.equal(r.headers.get('retry-after'), null);
  assert.equal((await r.json()).error.type, 'agent_router_empty_response');
});

test('Missing usage or nonempty tool output must not count as an empty completion', async () => {
  for (const response of [
    { status: 'completed', output: [] },
    { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } },
    { status: 'completed', output: [{ type: 'function_call', name: 'example' }], usage: { input_tokens: 0, output_tokens: 0 } },
  ]) {
    const text = frame('response.completed', { type: 'response.completed', response });
    const r = await load(sse(text));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
  }
});

test('A healthy answer quoting rate-limit words remains byte-identical', async () => {
  const text = created + frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '中文🪶 ' + message }) + 'data: [DONE]\n\n';
  const r = await load(sse(text));
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), encoder.encode(text));
});

test('A live answer is released at first content, without waiting for stream completion', { timeout: 2000 }, async () => {
  let source;
  const first = frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' });
  const r = await load(sse(new ReadableStream({ start(c) { source = c; c.enqueue(encoder.encode(created + first)); } })));
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), created + first);
  source.enqueue(encoder.encode('data: [DONE]\n\n')); source.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: [DONE]\n\n');
  assert.equal((await reader.read()).done, true);
});

test('Late errors after reasoning, refusal or tool call are preserved, not retried', async () => {
  const outputs = [
    ['response.reasoning_summary_text.delta', { delta: 'thinking' }],
    ['response.refusal.delta', { delta: 'cannot comply' }],
    ['response.output_item.added', { item: { type: 'function_call', name: 'tool', call_id: 'call1', arguments: '' } }],
    ['message', { choices: [{ delta: { tool_calls: [{ id: 'call1', function: { name: 'tool' } }] } }] }],
  ];
  for (const [type, data] of outputs) {
    const text = created + frame(type, { type, ...data }) + fail;
    const r = await load(sse(text));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
  }
});

test('Unknown and non-text semantic events release before any later error', async () => {
  const firstEvents = [
    'event: unknown\n\n',
    frame('unknown', { choices: [] }),
    frame('unknown', { type: 'response.created', response: { output: [] } }),
    frame('response.output_item.added', { type: 'response.output_item.added', item: { type: 'message', content: [{ type: 'output_audio', data: 'audio' }] } }),
    frame('response.output_item.added', { type: 'response.output_item.added', item: { type: 'reasoning', encrypted_content: 'opaque' } }),
    frame('response.content_part.added', { type: 'response.content_part.added', part: { type: 'image', url: 'https://example.invalid/image' } }),
    frame('message', { choices: [{ delta: { audio: { data: 'audio' } } }] }),
    frame('message', { choices: [{ delta: { future_field: 'opaque' } }] }),
  ];
  for (const first of firstEvents) {
    const text = created + first + fail;
    const r = await load(sse(text));
    assert.equal(r.status, 200, first);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), encoder.encode(text));
  }
});

test('Mixed SSE newlines, multiline data and byte-split UTF8 still classify early failure', async () => {
  const text = ': 中文🪶\r\ndata: {"error":\rdata: {"code":"server_error","message":"fixture"}}\n\r\n';
  const bytes = encoder.encode(text);
  let i = 0;
  const r = await load(sse(new ReadableStream({
    pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); },
  })));
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error.type, 'agent_router_upstream_error');
});

test('Unknown errors and truncated preludes remain unchanged', async () => {
  for (const text of [frame('error', { error: { code: 'insufficient_quota', message: 'out of quota' } }), created, 'event: error\ndata: {', '']) {
    const r = await load(sse(text));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
  }
});
