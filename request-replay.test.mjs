import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";

const url = "https://agentrouter.org/v1/responses";
const history = () => ({ model: "model", store: true, stream: true, input: [
  { role: "user", content: "Keep the literal msg_old and call_old in this text." },
  { type: "message", id: "msg_old", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Checking", annotations: [] }] },
  { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "opaque-sealed-value" },
  { type: "function_call", id: "fc_old", call_id: "call_old", name: "lookup", arguments: JSON.stringify({ id: "nested-id" }) },
  { type: "function_call_output", id: "fco_old", call_id: "call_old", output: JSON.stringify({ id: "result-id", value: 42 }) },
], tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { id: { type: "string" } } } }] });
async function loader(enabled = true) {
  const p = await plugin({ magpie: { option: (_provider, name) => name === "portable-responses" ? enabled : true } });
  return p.auth.loader(async () => ({ type: "api", key: "test-key", metadata: { site: "org" } }), {});
}
async function capture(t, input, init, enabled = true) {
  const old = globalThis.fetch; let seen;
  globalThis.fetch = async (input, init) => { seen = { input, init }; return new Response("ok"); };
  t.after(() => { globalThis.fetch = old; });
  const l = await loader(enabled); await l.fetch(input, init); return seen;
}
test("portable inline history does not look up IDs on a different resource", async t => {
  const before = history(); const body = JSON.stringify(before);
  const seen = await capture(t, url, { method: "POST", body });
  const after = JSON.parse(seen.init.body);
  const expected = structuredClone(before); expected.store = false;
  for (const item of expected.input) delete item.id;
  delete expected.input[1].status;
  expected.input[2] = { type: "reasoning", summary: [] };
  assert.deepEqual(after, expected);
  assert.deepEqual(JSON.parse(body), before);
});
test("rewriting removes stale body-integrity headers but keeps request identity and signal", async t => {
  const controller = new AbortController();
  const seen = await capture(t, url, { method: "POST", body: JSON.stringify(history()), signal: controller.signal, headers: { "content-length": "100", "content-md5": "old", "digest": "old", "content-digest": "old", "content-type": "application/json", "x-session-id": "session-42" } });
  const h = new Headers(seen.init.headers);
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) assert.equal(h.has(name), false);
  assert.equal(h.get("x-session-id"), "session-42"); assert.equal(seen.init.signal, controller.signal);
});
test("Request inputs are cloned without consuming the original body", async t => {
  const body = JSON.stringify(history()); const req = new Request(url, { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), "digest": "old" } });
  const seen = await capture(t, req);
  assert.equal(new Headers(seen.init.headers).has("content-length"), false);
  assert.equal(new Headers(seen.init.headers).has("digest"), false);
  assert.equal(JSON.parse(seen.init.body).input[1].id, undefined);
  assert.equal(await req.text(), body);
});
test("provider switch restores exact original body forwarding", async t => {
  const body = JSON.stringify(history(), null, 2);
  const seen = await capture(t, url, { method: "POST", body }, false); assert.equal(seen.init.body, body);
});
for (const state of [{ previous_response_id: "resp_remote" }, { conversation: "conv_remote" }, { input: [{ type: "item_reference", id: "msg_remote" }] }]) {
  test("server-only context is never silently discarded: " + Object.keys(state)[0], async t => {
    const body = JSON.stringify({ ...history(), ...state }); const seen = await capture(t, url, { method: "POST", body });
    assert.equal(seen.init.body, body);
  });
}
for (const path of ["/v1/chat/completions", "/v1/responses/compact"]) test("other endpoints stay byte-identical: " + path, async t => {
  const body = JSON.stringify(history()); const seen = await capture(t, "https://agentrouter.org" + path, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("unknown items and compaction retain every field while reasoning is reduced", async t => {
  const before = { store: false, input: [ { type: "reasoning", id: "rs_reference", summary: [] }, { type: "future_item", id: "future_1", payload: "opaque" }, { type: "function_call", id: "fc_reference" }, { type: "compaction", id: "cmp_1", encrypted_content: "opaque" } ] };
  const body = JSON.stringify(before); const seen = await capture(t, url, { method: "POST", body });
  assert.deepEqual(JSON.parse(seen.init.body), { store: false, input: [
    { type: "reasoning", summary: [] }, before.input[1], before.input[2], before.input[3],
  ] });
});
test("GET, malformed JSON and encoded bodies stay untouched", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; }); const seen=[];
  globalThis.fetch = async (_input, init) => { seen.push(init); return new Response("ok"); };
  const l = await loader();
  await l.fetch(url, { method: "GET" });
  await l.fetch(url, { method: "POST", body: "{bad" });
  await l.fetch(url, { method: "POST", body: JSON.stringify(history()), headers: { "content-encoding": "gzip" } });
  assert.equal(seen[0].body, undefined); assert.equal(seen[1].body, "{bad"); assert.equal(seen[2].body, JSON.stringify(history()));
});
test("resource rejection is actionable and never automatically retried", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; }); let calls = 0;
  const upstream = "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=test-trace]";
  globalThis.fetch = async () => { calls++; return Response.json({ error: { message: upstream } }, { status: 400 }); };
  const l = await loader(); const res = await l.fetch(url, { method: "POST", body: JSON.stringify({ previous_response_id: "resp_remote", input: "continue" }) });
  const data = await res.json(); assert.equal(res.status, 400); assert.equal(calls, 1);
  assert.equal(data.error.type, "agent_router_resource_mismatch"); assert.equal(data.error.upstream, upstream);
  assert.match(data.error.message, /trace_id=test-trace/);
});

test("annotated messages stay intact while opaque reasoning is reduced", async t => {
  const items = [ { type: "message", id: "msg_cited", role: "assistant", content: [{ type: "output_text", text: "Source", annotations: [{ type: "url_citation", url: "https://example.org" }] }] }, { type: "reasoning", id: "rs_sealed", summary: [], encrypted_content: "sealed" } ];
  const body = JSON.stringify({ store: true, input: items });
  const seen = await capture(t, url, { method: "POST", body });
  assert.deepEqual(JSON.parse(seen.init.body), { store: false, input: [items[0], { type: "reasoning", summary: [] }] });
});
test("over-limit and explicitly non-JSON bodies are not rewritten", async t => {
  const body = JSON.stringify({ ...history(), extra: "x".repeat(4 * 1024 * 1024) });
  const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("aborting a stalled Request clone promptly preserves the caller signal", async t => {
  const controller = new AbortController();
  const req = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void req.body.cancel().catch(() => {}); });
  const pending = capture(t, req, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10); t.after(() => clearTimeout(timer));
  const seen = await pending; assert.equal(seen.init.signal, controller.signal); assert.equal(seen.init.body, undefined);
});
test("HTTP 200 early resource failures become actionable 400 without retries", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; }); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('data: {"type":"response.failed","response":{"error":{"message":"The requested item was created under a different Azure OpenAI resource."}}}\n\n', { headers: { "content-type": "text/event-stream" } }); };
  const l = await loader(); const res = await l.fetch(url, { method: "POST", body: "{}" });
  assert.equal(res.status, 400); assert.equal((await res.json()).error.type, "agent_router_resource_mismatch"); assert.equal(calls, 1);
});

test("the direct body bound counts UTF-8 bytes, not UTF-16 code units", async t => {
  const body = JSON.stringify({ ...history(), extra: "中".repeat(1500000) });
  assert.ok(body.length < 4 * 1024 * 1024);
  const seen = await capture(t, url, { method: "POST", body }); assert.equal(seen.init.body, body);
});
test("explicit non-JSON content type leaves even JSON-looking data alone", async t => {
  const body = JSON.stringify(history());
  const seen = await capture(t, url, { method: "POST", body, headers: { "content-type": "text/plain" } }); assert.equal(seen.init.body, body);
});
test("oversized Request clones stop without consuming the original", async t => {
  const { prepareResponsesRequest } = await import("./request.mjs");
  const body = JSON.stringify({ ...history(), extra: "x".repeat(4 * 1024 * 1024) });
  const req = new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  const init = {}; assert.equal(await prepareResponsesRequest(req, init), init);
  assert.equal(await req.text(), body);
});
test("a stalled clone respects the preparation deadline", { timeout: 7000 }, async t => {
  const { prepareResponsesRequest } = await import("./request.mjs");
  const req = new Request(url, { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half" });
  t.after(() => { void req.body.cancel().catch(() => {}); });
  const init = {}; assert.equal(await prepareResponsesRequest(req, init), init);
});
