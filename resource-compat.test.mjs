import test from "node:test";
import assert from "node:assert/strict";
import { prepareResponsesRequest } from "./request.mjs";

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
    return body.input.some(item => item.id?.endsWith("resource_a"))
      ? Response.json(error, { status: 400 }) : Response.json({ output: [] });
  };
  assert.equal((await resourceB(init)).status, 400);
  attempts = 0;
  const result = await prepareResponsesRequest(url, init);
  assert.equal((await resourceB(result)).status, 200);
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(before), original);
  assert.deepEqual(JSON.parse(result.body), { store: false, input: [
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Looking up the item", annotations: [], logprobs: [] }] },
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

test("opaque reasoning becomes summary-only while compaction remains intact", async () => {
  const reasoning = { type: "reasoning", id: "rs_resource_a", encrypted_content: "synthetic-sealed-data", summary: [{ type: "summary_text", text: "kept summary" }] };
  const compaction = { type: "compaction", id: "cmp_resource_a", encrypted_content: "synthetic-compressed-data" };
  const result = await prepareResponsesRequest(url, { method: "POST", body: JSON.stringify({ input: [message(), reasoning, compaction] }) });
  const after = JSON.parse(result.body);
  assert.equal(after.input[0].id, undefined);
  assert.deepEqual(after.input[1], { type: "reasoning", summary: [{ type: "summary_text", text: "kept summary" }] });
  assert.deepEqual(after.input[2], compaction);
});
