import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainResponse } from './response.mjs';

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

test('Malformed metadata is unknown data, not a parser exception or an invented 429', async () => {
  const text = 'event: strange\ndata: {"response":{"output":{}},"item":{"type":"message","content":3}}\n\n';
  const res = await explainResponse(sse(text));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), text);
});
