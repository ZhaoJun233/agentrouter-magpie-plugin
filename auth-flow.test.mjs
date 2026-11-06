import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";

test("onboarding keeps native API Key input and only the GitHub system-token prompt", async () => {
  const p = await plugin({ magpie: {} });
  assert.deepEqual(p.auth.methods.map(m => m.type), ["api", "oauth"]);
  assert.deepEqual(p.auth.methods[0].prompts ?? [], []);
  assert.deepEqual(p.auth.methods[1].prompts.map(p => p.key), ["accessToken"]);
  assert.equal(p.auth.methods[1].prompts[0].type, "password");
});

test("missing model Key fails locally without forwarding SDK placeholder or management credentials", async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true }); };
  t.after(() => { globalThis.fetch = original; });
  const p = await plugin({ magpie: { options: () => ({ "text-filter": false, "portable-responses": false }) } });
  for (const auth of [null, undefined, {}, { type: "api", key: "", metadata: { accessToken: "private-management-token", githubCookie: "user_session=private-session" } }]) {
    const loader = await p.auth.loader(async () => auth);
    const request = new Request("https://agentrouter.org/v1/responses", { method: "POST", headers: { Authorization: "Bearer agentrouter", "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", input: "hi" }) });
    const result = await loader.fetch(request);
    assert.equal(calls, 0);
    assert.equal(request.bodyUsed, false);
    assert.equal(result.status, 400);
    const text = await result.text();
    assert.equal(JSON.parse(text).error.code, "agentrouter_missing_api_key");
    assert.ok(!text.includes("private-"));
  }
});
const modelKey = "synthetic-model-key";
const entry = (key = modelKey, extra = {}) => ({ status: 1, key, ...extra });
async function githubResult(t, payload, status = 200) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (req, init = {}) => {
    const url = new URL(req instanceof Request ? req.url : String(req));
    calls.push({ url: url.href, method: init.method ?? "GET" });
    if (url.pathname === "/api/oauth/state") return Response.json({ success: true, data: "fixture-state" });
    if (url.pathname === "/api/status") return Response.json({ data: { github_client_id: "fixture-client", server_address: "https://agentrouter.org" } });
    if (url.pathname === "/api/oauth/github") return Response.json({ success: true, data: { id: 42 } });
    if (url.pathname === "/api/token/") {
      assert.equal(new Headers(init.headers).get("Authorization"), "synthetic-system-secret");
      if (payload instanceof Error) throw payload;
      if (typeof payload === "string") return new Response(payload, { status });
      return Response.json(payload, { status });
    }
    throw new Error("Unexpected mock request: " + url.pathname);
  };
  t.after(() => { globalThis.fetch = original; });
  const p = await plugin({ magpie: {} });
  const flow = await p.auth.methods[1].authorize({ accessToken: "synthetic-system-secret" });
  assert.equal(flow.method, "code", "mock authorization must produce an OAuth flow: " + JSON.stringify(flow));
  const callback = new URL(new URL(flow.url).searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "synthetic-code-secret");
  callback.searchParams.set("state", "fixture-state");
  const result = await flow.callback(callback.href);
  assert.ok(calls.every(c => c.method === "GET"));
  assert.equal(calls.filter(c => new URL(c.url).pathname === "/api/token/").length, 1);
  return result;
}

for (const [label, payload] of [
  ["data.items", { data: { items: [entry()] } }],
  ["data array", { data: [entry()] }],
  ["skips empty first key", { data: { items: [entry("  "), entry()] } }],
  ["deduplicates trimmed keys", { data: { items: [entry(" " + modelKey), entry(modelKey + " ")] } }],
  ["skips disabled keys", { data: { items: [entry("disabled", { status: 2 }), entry()] } }],
  ["skips expired keys", { data: { items: [entry("expired", { expired_time: 1 }), entry(modelKey, { expired_time: -1 })] } }],
  ["explicit complete page", { data: { total: 10, items: [...Array.from({ length: 9 }, () => entry("")), entry()] } }],
]) {
  test("GitHub chooses the unique known valid key: " + label, async t => {
    const result = await githubResult(t, payload);
    assert.equal(result.type, "success");
    assert.equal(result.key, modelKey);
  });
}

for (const [label, payload, status = 200] of [
  ["empty list", { data: { items: [] } }],
  ["disabled only", { data: { items: [entry(modelKey, { status: 2 })] } }],
  ["missing active status", { data: { items: [{ key: modelKey }] } }],
  ["expired only", { data: { items: [entry(modelKey, { expired_time: 1 })] } }],
  ["SDK placeholder", { data: { items: [entry("agentrouter")] } }],
  ["documentation placeholder", { data: { items: [entry("YOUR_API_KEY")] } }],
  ["masked key", { data: { items: [entry("sk-****")] } }],
  ["multiple different keys", { data: { items: [entry(), entry("another-real-key")] } }],
  ["page may be truncated", { data: { items: Array.from({ length: 10 }, () => entry()) } }],
  ["explicit additional page", { data: { total: 2, items: [entry()] } }],
  ["invalid total", { data: { total: "1", items: [entry()] } }],
  ["unknown structure", { items: [entry()] }],
  ["business failure", { success: false, message: "synthetic-system-secret", data: { items: [entry()] } }],
  ["HTTP auth failure", { data: { items: [entry()] } }, 401],
  ["HTTP forbidden", { data: { items: [entry()] } }, 403],
  ["invalid JSON", "synthetic-system-secret"],
  ["HTML verification", "<!doctype html>synthetic-system-secret", 403],
  ["network error", new Error("synthetic-system-secret")],
]) {
  test("GitHub fails without saving a key: " + label, async t => {
    const result = await githubResult(t, payload, status);
    assert.equal(result.type, "failed");
    assert.equal(typeof result.error, "string");
    assert.match(result.error, /API Key/);
    assert.equal("key" in result, false);
    assert.ok(!JSON.stringify(result).includes("synthetic-system-secret"));
    assert.ok(!JSON.stringify(result).includes("synthetic-code-secret"));
  });
}
