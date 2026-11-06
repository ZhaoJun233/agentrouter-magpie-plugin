import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";

const url = "https://example.test/v1/responses";
const auth = { type: "api", key: "synthetic-model-key", metadata: {
  githubCookieMode: "configure", githubCookie: "user_session=synthetic-github-cookie; logged_in=yes",
  cookie: "session=synthetic-site-cookie", accessToken: "synthetic-access-token", userId: "123",
} };

test("login cookies and site token never enter model requests during inline replay", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({input, init}); return Response.json({ output: [] }); };
  for (const enabled of [false, true]) {
    const p = await plugin({ magpie: { option: (_pid, key) => key === "portable-responses" ? enabled : false } });
    const loader = await p.auth.loader(async () => auth, {});
    const body = JSON.stringify({ input: [{ type: "message", id: "msg_resource_a", role: "assistant", content: [
      { type: "output_text", text: "Synthetic response", annotations: [], logprobs: [] },
    ] }] });
    await loader.fetch(url, { method: "POST", body });
    const sent = calls.at(-1).init;
    const headers = new Headers(sent.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-model-key");
    assert.equal(headers.has("cookie"), false);
    const wire = JSON.stringify({ headers: [...headers], body: sent.body });
    for (const privateValue of ["synthetic-github-cookie", "synthetic-site-cookie", "synthetic-access-token"])
      assert.equal(wire.includes(privateValue), false);
    assert.equal(JSON.parse(sent.body).input[0].id, enabled ? undefined : "msg_resource_a");
  }
  assert.equal(calls.length, 2);
});

for (const [label, item] of [
  ["reasoning", {type:"reasoning",id:"rs_resource_a",summary:[],encrypted_content:"synthetic-opaque"}],
  ["compaction", {type:"compaction",id:"cmp_resource_a",encrypted_content:"synthetic-opaque"}],
  ["attachment", {role:"user",content:[{type:"input_file",file_id:"file_resource_a"}]}],
  ["reference", {type:"item_reference",id:"msg_resource_a"}],
]) test(label + " rejection stays explicit and never retrieves or retries private history", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0, sent;
  globalThis.fetch = async (_input, init) => {
    calls++; sent = JSON.parse(init.body);
    return Response.json({ error: { message: "The requested item was created under a different Azure OpenAI resource. [trace_id=synthetic-trace]" } }, { status: 400 });
  };
  const p = await plugin({ magpie: { option: (_pid, key) => key === "portable-responses" } });
  const loader = await p.auth.loader(async () => auth, {});
  const before = { input: [item] };
  const res = await loader.fetch(url, { method: "POST", body: JSON.stringify(before) });
  assert.equal(calls, 1);
  assert.deepEqual(sent, before);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.type, "agent_router_resource_mismatch");
  assert.match(data.error.message, /synthetic-trace/);
});
