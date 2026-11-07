import test from "node:test";
import assert from "node:assert/strict";
import { prepareRequest, prepareResponsesRequest } from "./request.mjs";

const url = "https://example.test/v1/responses";
// Mirrors the gateway's completed output_text part, with no probability data.
const message = (extra = {}) => ({
  id: "msg_resource_a", type: "message", role: "assistant", status: "completed", phase: "commentary",
  content: [{ type: "output_text", text: "Looking up the item", annotations: [], logprobs: [], ...extra }],
});
const error = { error: { message: "The requested item was created under a different Azure OpenAI resource." } };

test("gateway output with empty logprobs replays on a different synthetic resource", async () => {
  const before = { store: true, input: [message(),
    { type: "function_call", id: "fc_resource_a", call_id: "call_keep", name: "lookup", arguments: '{"id":"nested_keep"}' },
    { type: "function_call_output", id: "out_resource_a", call_id: "call_keep", output: '{"id":"result_keep"}' },
  ] };
  const original = JSON.stringify(before);
  const init = { method: "POST", body: original, headers: { "content-length": String(original.length), "x-session-id": "keep-session" } };
  // A deterministic substitute, not a real resource and not a replay of private history.
  let attempts = 0;
  const resourceB = async request => {
    attempts++;
    const body = JSON.parse(request.body);
    if (body.input.some(item => item.id?.endsWith("resource_a"))) return Response.json(error, { status: 400 });
    if (body.input.some(item => item.role === "assistant" && item.content?.some(part => part.type === "input_text"))) {
      return Response.json({ error: { message: "Assistant messages require output_text, not input_text." } }, { status: 400 });
    }
    return Response.json({ output: [] });
  };
  assert.equal((await resourceB(init)).status, 400);
  attempts = 0;
  const result = await prepareResponsesRequest(url, init);
  assert.equal((await resourceB(result)).status, 200);
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(before), original);
  assert.deepEqual(JSON.parse(result.body), { store: false, input: [
    { type: "message", role: "assistant", phase: "commentary", content: message().content },
    { type: "function_call", call_id: "call_keep", name: "lookup", arguments: '{"id":"nested_keep"}' },
    { type: "function_call_output", call_id: "call_keep", output: '{"id":"result_keep"}' },
  ] });
  assert.equal(new Headers(result.headers).has("content-length"), false);
  assert.equal(new Headers(result.headers).get("x-session-id"), "keep-session");
});

for (const [label, extra] of [
  ["nonempty logprobs", { logprobs: [{ token: "sample", logprob: -1 }] }],
  ["invalid logprobs", { logprobs: {} }],
  ["null logprobs", { logprobs: null }],
  ["citations", { annotations: [{ type: "url_citation", url: "https://example.test" }] }],
  ["future fields", { future_data: [] }],
]) test(label + " remain intact instead of silently losing data", async () => {
  const init = { method: "POST", body: JSON.stringify({ store: true, input: [message(extra)] }) };
  const result = await prepareResponsesRequest(url, init);
  assert.equal(result, init);
});

for (const pointer of [ { previous_response_id: "resp_resource_a" }, { conversation: "conv_resource_a" },
  { input: [message(), { type: "item_reference", id: "msg_resource_a" }] },
]) test("empty logprobs support does not discard server history: " + Object.keys(pointer)[0], async () => {
  const init = { method: "POST", body: JSON.stringify({ store: true, input: [message()], ...pointer }) };
  assert.equal((await prepareResponsesRequest(url, init)), init);
});

test("opaque reasoning and compaction survive an adjacent inline message rewrite", async () => {
  const opaque = [ { type: "reasoning", id: "rs_resource_a", encrypted_content: "synthetic-sealed-data", summary: [] },
    { type: "compaction", id: "cmp_resource_a", encrypted_content: "synthetic-compressed-data" } ];
  const result = await prepareResponsesRequest(url, { method: "POST", body: JSON.stringify({ input: [message(), ...opaque] }) });
  const after = JSON.parse(result.body);
  assert.equal(after.input[0].id, undefined);
  assert.deepEqual(after.input.slice(1), opaque);
});

for (const role of ["assistant", "user", "system", "developer"]) {
  test(role + " replay uses the role-appropriate text type", async () => {
    const item = { ...message(), role };
    const before = JSON.stringify({ input: [item] });
    const result = await prepareResponsesRequest(url, { method: "POST", body: before });
    const after = JSON.parse(result.body).input[0];
    assert.equal(after.id, undefined);
    assert.equal(after.status, undefined);
    assert.equal(after.phase, item.phase);
    assert.deepEqual(after.content, role === "assistant" ? item.content : [{ type: "input_text", text: item.content[0].text }]);
    assert.equal(JSON.stringify({ input: [item] }), before);
  });
}

test("reasoning state and reference-only items survive adjacent assistant replay", async () => {
  const state = [
    { type: "reasoning", id: "rs_empty", summary: [], encrypted_content: "synthetic-sealed" },
    { type: "reasoning", id: "rs_summary", summary: [{ type: "summary_text", text: "Visible summary" }], encrypted_content: "synthetic-sealed" },
    { type: "reasoning", id: "rs_reference" },
    { type: "reasoning", summary: [], future_state: { value: "synthetic-unknown" } },
    { type: "function_call", id: "fc_reference" },
    { type: "future_item", id: "future_reference", payload: "synthetic-opaque" },
  ];
  const result = await prepareResponsesRequest(url, { method: "POST", body: JSON.stringify({ input: [message(), ...state] }) });
  const after = JSON.parse(result.body);
  assert.equal(after.input[0].id, undefined);
  assert.deepEqual(after.input[0].content, message().content);
  assert.deepEqual(after.input.slice(1), state);
});

test("disabling portable replay forwards assistant and reasoning bytes unchanged", async () => {
  const init = { method: "POST", body: JSON.stringify({ store: true, input: [message(),
    { type: "reasoning", id: "rs_reference", summary: [], encrypted_content: "synthetic-sealed" },
  ] }, null, 2) };
  assert.equal(await prepareRequest(url, init, { portableResponses: false }), init);
});

test("assistant output without an item ID stays byte-identical", async () => {
  const item = message(); delete item.id;
  const init = { method: "POST", body: JSON.stringify({ input: [item] }, null, 2) };
  assert.equal(await prepareResponsesRequest(url, init), init);
});
