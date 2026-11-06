import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainResponse } from './response.mjs';

test("approved server_error code mapping is HTTP 500", async () => {
  const response = new Response(JSON.stringify({ error: { code: "server_error", message: "Synthetic server failure" } }), { headers: { "content-type": "application/json" } });
  const result = await explainResponse(response);
  assert.equal(result.status, 500);
  assert.equal((await result.json()).error.type, "agent_router_upstream_error");
});

test("approved numeric strings and msg envelopes are recognized conservatively", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const response = new Response(JSON.stringify({ error: { status: String(status), msg: "Synthetic message" } }), { headers: { "content-type": "application/json" } });
    const result = await explainResponse(response);
    assert.equal(result.status, status);
    assert.equal((await result.json()).error.upstream, "Synthetic message");
  }
  const nested = new Response(JSON.stringify({ error: { msg: JSON.stringify({ error: { code: "rate_limit_exceeded", msg: "Synthetic nested message" } }) } }), { headers: { "content-type": "application/json" } });
  assert.equal((await explainResponse(nested)).status, 429);
  for (const status of ["401", "402", "403"]) {
    const response = new Response(JSON.stringify({ error: { status, code: "high_demand", msg: "currently experiencing high demand" } }), { headers: { "content-type": "application/json" } });
    assert.equal(await explainResponse(response), response);
  }
});

test("approved busy phrase is classified only in explicit non-business errors", async () => {
  const phrase = "We are currently experiencing high demand. Please try again later.";
  for (const body of [{ error: { message: phrase } }, { error: { msg: phrase } }]) {
    const result = await explainResponse(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.type, "agent_router_upstream_busy");
  }
  for (const body of [{ message: phrase }, { error: { message: "high demand" } }, { error: { code: "invalid_api_key", message: phrase } }]) {
    const response = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    assert.equal(await explainResponse(response), response);
  }
});

const enc = new TextEncoder();
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('A prelude over 64 KiB is released byte-for-byte without more reads', async () => {
  const bytes = enc.encode(': ' + 'x'.repeat(65 * 1024) + '\n\n');
  let source;
  const body = new ReadableStream({ start(c) { source = c; c.enqueue(bytes); } });
  const res = await explainResponse(sse(body));
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  source.close();
  assert.equal((await reader.read()).done, true);
});

test('The inspection deadline releases a quiet prelude without losing its pending read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let source;
  const response = explainResponse(sse(new ReadableStream({ start(c) { source = c; } })));
  t.mock.timers.tick(15_000);
  const res = await response;
  const bytes = enc.encode('data: {"choices":[{"delta":{"content":"after deadline"}}]}\n\n');
  source.enqueue(bytes);
  source.close();
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test('Cancelling a replayed body cancels the upstream reader', async () => {
  let cancelled = false;
  const bytes = enc.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  const res = await explainResponse(sse(new ReadableStream({
    start(c) { c.enqueue(bytes); },
    cancel() { cancelled = true; },
  })));
  await res.body.cancel('caller left');
  assert.equal(cancelled, true);
});

test('JSON inspection accepts exactly 64 KiB but fails open above the byte budget', async () => {
  const small = JSON.stringify({ error: { code: 'server_error', message: 'fixture' } });
  for (const size of [64 * 1024, 64 * 1024 + 1]) {
    const text = small + ' '.repeat(size - enc.encode(small).byteLength);
    const original = new Response(text, { headers: { 'content-type': 'application/json' } });
    const result = await explainResponse(original);
    if (size === 64 * 1024) assert.equal(result.status, 500);
    else {
      assert.equal(result, original);
      assert.equal(await result.text(), text);
    }
  }
});

test('Invalid JSON UTF8 fails open instead of classifying replacement characters', async () => {
  const prefix = enc.encode('{"error":{"code":"server_error","message":"');
  const suffix = enc.encode('"}}');
  const bytes = new Uint8Array([...prefix, 255, ...suffix]);
  const original = new Response(bytes, { headers: { 'content-type': 'application/json' } });
  const result = await explainResponse(original);
  assert.equal(result, original);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
});

test('A stalled JSON clone fails open within the two-second deadline without waiting for cancel', { timeout: 5000 }, async () => {
  let source, timer;
  const prefix = enc.encode('{"error":');
  const original = new Response(new ReadableStream({ start(c) { source = c; c.enqueue(prefix); } }), {
    headers: { 'content-type': 'application/json' },
  });
  const pending = explainResponse(original);
  try {
    const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2700); })]);
    assert.equal(result, original);
  } finally {
    clearTimeout(timer);
    source.close();
    await pending;
  }
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), prefix);
});

test('JSON inspection leaves out-of-scope statuses and unrecognized envelopes untouched', async () => {
  for (const status of [201, 401, 403, 500, 502, 503, 504]) {
    const text = JSON.stringify({ error: { code: 'server_error' } });
    const original = new Response(text, { status, headers: { 'content-type': 'application/json' } });
    assert.equal(await explainResponse(original), original);
    assert.equal(await original.text(), text);
  }
  for (const value of [{ error: {} }, { output: [{ text: 'server_error' }] }, { message: 'fixture', status: 503 }]) {
    const text = JSON.stringify(value);
    const original = new Response(text, { headers: { 'content-type': 'application/json' } });
    assert.equal(await explainResponse(original), original);
    assert.equal(await original.text(), text);
  }
});

test('Known JSON errors retain the existing HTTP400 and HTTP429 inspection scope', async () => {
  for (const status of [200, 400, 429]) {
    const result = await explainResponse(new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
      status, headers: { 'content-type': 'application/json', 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' },
    }));
    assert.equal(result.status, 429);
    assert.equal(result.headers.get('retry-after'), 'Thu, 01 Jan 2026 00:00:00 GMT');
  }
});

test('JSON reader errors fail open and preserve the original read error', async () => {
  const problem = new Error('fixture source broke');
  const original = new Response(new ReadableStream({ start(c) { c.error(problem); } }), {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(await explainResponse(original), original);
  await assert.rejects(original.text(), /fixture source broke/);
});

test('Replay applies backpressure and never observes late error bytes', async () => {
  const first = enc.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  const late = enc.encode('event: error\ndata: {"code":"server_error"}\n\n');
  const chunks = [first, late];
  let reads = 0;
  const result = await explainResponse(sse(new ReadableStream({
    pull(c) { reads++; if (chunks.length) c.enqueue(chunks.shift()); else c.close(); },
  }, { highWaterMark: 0 })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([...first, ...late]));
});

test('Early SSE cancellation does not await an upstream cancel promise', { timeout: 1000 }, async () => {
  let cancelled = false;
  const result = await explainResponse(sse(new ReadableStream({
    start(c) { c.enqueue(enc.encode('event: error\ndata: {"code":"server_error"}\n\n')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })));
  assert.equal(result.status, 500);
  assert.equal(cancelled, true);
});

test('Malformed metadata is unknown data, not a parser exception or an invented 429', async () => {
  const text = 'event: strange\ndata: {"response":{"output":{}},"item":{"type":"message","content":3}}\n\n';
  const res = await explainResponse(sse(text));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), text);
});
