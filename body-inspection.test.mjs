import assert from "node:assert/strict";
import { test } from "node:test";
import { readCloneText } from "./body-inspection.mjs";

const enc = new TextEncoder();
const options = { maxBytes: 64 * 1024, timeoutMs: 2000 };

test("bounded inspection reads Request and Response without consuming the original", async () => {
  const text = "hello 世界";
  for (const source of [new Request("https://example.invalid/responses", { method: "POST", body: text }), new Response(text)]) {
    assert.equal(await readCloneText(source, { ...options, maxBytes: enc.encode(text).length }), text);
    assert.equal(source.bodyUsed, false);
    assert.equal(await source.text(), text);
  }
});

test("byte limits do not trust Content-Length or count UTF-16 characters", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "999999" }]) {
    const source = new Response("世界", { headers });
    assert.equal(await readCloneText(source, { ...options, maxBytes: 5 }), null);
    assert.equal(source.bodyUsed, false);
    assert.equal(await source.text(), "世界");
  }
});

test("split UTF-8 is decoded at completion and the original bytes remain intact", async () => {
  const bytes = enc.encode("a世界z");
  const source = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  assert.equal(await readCloneText(source, { ...options, maxBytes: bytes.length }), "a世界z");
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()), bytes);
});

test("malformed or truncated UTF-8 abandons inspection, not the original body", async () => {
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xb8)]) {
    const source = new Response(bytes);
    assert.equal(await readCloneText(source, options), null);
    assert.deepEqual(new Uint8Array(await source.arrayBuffer()), bytes);
  }
});

test("a quiet clone times out without awaiting its original tee consumer", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let controller;
  const source = new Response(new ReadableStream({ start(c) { controller = c; } }));
  const pending = readCloneText(source, options);
  t.mock.timers.tick(2000);
  assert.equal(await pending, null);
  assert.equal(source.bodyUsed, false);
  controller.enqueue(enc.encode("after deadline"));
  controller.close();
  assert.equal(await source.text(), "after deadline");
});

test("abort during a pending read preserves the original and abort reason", { timeout: 2000 }, async () => {
  const ac = new AbortController();
  const reason = new Error("caller left");
  let controller;
  const source = new Response(new ReadableStream({ start(c) { controller = c; } }));
  const pending = readCloneText(source, { ...options, signal: ac.signal });
  ac.abort(reason);
  assert.equal(await pending, null);
  assert.equal(ac.signal.reason, reason);
  assert.equal(source.bodyUsed, false);
  controller.enqueue(enc.encode("still available"));
  controller.close();
  assert.equal(await source.text(), "still available");
});

test("an already-aborted inspection does not consume its source", async () => {
  const ac = new AbortController();
  ac.abort("already cancelled");
  const source = new Response("unchanged");
  assert.equal(await readCloneText(source, { ...options, signal: ac.signal }), null);
  assert.equal(source.bodyUsed, false);
  assert.equal(await source.text(), "unchanged");
});

test("a read failure remains observable when the caller reads the original", async () => {
  const source = new Response(new ReadableStream({ start(c) { c.error(new Error("upstream failure")); } }));
  assert.equal(await readCloneText(source, options), null);
  assert.equal(source.bodyUsed, false);
  await assert.rejects(source.text(), /upstream failure/);
});

test("empty, unavailable and consumed bodies have explicit inconclusive results", async () => {
  assert.equal(await readCloneText(new Response(""), { ...options, maxBytes: 0 }), "");
  assert.equal(await readCloneText(new Response(null), options), null);
  const used = new Response("used");
  await used.text();
  assert.equal(await readCloneText(used, options), null);
});

test("invalid inspection bounds cannot accidentally enable an unbounded read", async () => {
  for (const invalid of [{ maxBytes: undefined }, { maxBytes: -1 }, { maxBytes: Infinity }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    const source = new Response("untouched");
    assert.equal(await readCloneText(source, { ...options, ...invalid }), null);
    assert.equal(source.bodyUsed, false);
    assert.equal(await source.text(), "untouched");
  }
});
