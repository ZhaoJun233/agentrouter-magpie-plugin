import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";
import { parseGithubCookie } from "./github-cookie.mjs";

const valid = "user_session=synthetic-session; logged_in=yes";
const callback = "https://agentrouter.org/oauth/github/magpie?code=synthetic-code&state=synthetic-state";
const raw = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
const methodOf = (p, type) => p.auth.methods.find(m => m.type === type);
// Magpie's failed() adapter consumes error, not message.
function hostFailed(r) {
  const why = typeof r?.error === "string" ? r.error.trim() : r?.error instanceof Error ? r.error.message : "";
  return why ? { ok: false, error: why.slice(0, 500) } : { ok: false };
}
async function stubFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.ok(responses.length, "unexpected request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const oauthResponses = () => [
  raw({ success: true, data: "synthetic-state" }),
  raw({ data: { github_client_id: "synthetic-client", server_address: "https://agentrouter.org" } }),
  raw({ success: true, data: { id: 42 } }, { "Set-Cookie": "session=synthetic-site; Path=/; HttpOnly" }),
  raw({ success: true, data: { items: [{ status: 1, key: "synthetic-api-key" }] } }),
];

test("first login has no optional settings or duplicate API key input", async () => {
  const p = await plugin({ magpie: {} });
  assert.deepEqual(p.auth.methods.map(m => m.type), ["api", "oauth"]);
  assert.deepEqual(methodOf(p, "api").prompts ?? [], []);
  const prompts = methodOf(p, "oauth").prompts;
  assert.deepEqual(prompts.map(p => p.key), ["accessToken"]);
  assert.equal(prompts[0].type, "password");
  assert.equal(prompts[0].validate("synthetic-access"), undefined);
  assert.ok(prompts[0].validate(" "));
  assert.match(prompts[0].message, /不是模型 API Key/);
});

test("API finalization is local and leaves the host as sole key owner", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  await stubFetch([], async calls => {
    const inputs = { site: "air", githubCookie: "synthetic-private", accessToken: "synthetic-access" };
    const before = structuredClone(inputs);
    const result = await method.authorize(inputs);
    assert.deepEqual(result, { type: "success", metadata: { site: "org" } });
    assert.ok(!Object.hasOwn(result, "key"));
    assert.ok(!Object.hasOwn(result, "verified"));
    assert.deepEqual(inputs, before);
    assert.equal(calls.length, 0);
  });
});

test("hosts without Magpie retain native API-key entry without a finalize hook", async () => {
  assert.equal(methodOf(await plugin(), "api").authorize, undefined);
});

test("GitHub rejects missing management token locally with host-visible guidance", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch([], async calls => {
    for (const value of [undefined, "", " "]) {
      const result = await method.authorize({ accessToken: value });
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, /系统访问令牌/);
    }
    assert.equal(calls.length, 0);
  });
});

test("OAuth configuration failures are safe and never become authorization flows", async () => {
  const method = methodOf(await plugin(), "oauth");
  for (const responses of [
    [new Error("synthetic-private network")],
    [raw({ success: false, message: "synthetic-private" })],
    [raw({ success: true, data: {} })],
    [oauthResponses()[0], raw({ data: {} })],
    [oauthResponses()[0], raw({ data: { github_client_id: "synthetic-client", server_address: "https://foreign.invalid" } })],
  ]) {
    await stubFetch(responses, async () => {
      const result = await method.authorize({ accessToken: "synthetic-access" });
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, /API Key/);
      assert.ok(!JSON.stringify(result).includes("synthetic"));
    });
  }
});

test("OAuth captures only its token and saves a usable model key plus site session", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch(oauthResponses(), async calls => {
    const inputs = { accessToken: "synthetic-access", githubCookie: valid, site: "air", headers: "X-Private: ignored" };
    const flow = await method.authorize(inputs);
    inputs.accessToken = "changed-private";
    const result = await flow.callback(callback);
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-api-key");
    assert.deepEqual(result.metadata, { accessToken: "synthetic-access", userId: "42", site: "org", cookie: "session=synthetic-site" });
    assert.ok(calls.every(c => c.url.startsWith("https://agentrouter.org/")));
    assert.ok(calls.every(c => !new Headers(c.init.headers).has("Cookie")));
    assert.equal(new Headers(calls[3].init.headers).get("Authorization"), "synthetic-access");
  });
});

test("OAuth bare codes and exchange network errors fail safely", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch(oauthResponses().slice(0, 2), async calls => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    assert.equal((await flow.callback("synthetic-code")).type, "failed");
    assert.equal(calls.length, 2);
  });
  await stubFetch([...oauthResponses().slice(0, 2), new Error("synthetic-private")], async () => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    const result = await flow.callback(callback);
    assert.equal(result.type, "failed");
    assert.match(hostFailed(result).error, /重新/);
    assert.ok(!JSON.stringify(result).includes("synthetic"));
  });
});

// Cookie parsing remains an advanced/manual capability, not an onboarding prompt.
test("Cookie validation accepts supported formats without network access", async () => {
  const validate = value => parseGithubCookie(value).error;
  const inputs = [valid, "Cookie: " + valid, "__Host-user_session_same_site=synthetic-host", "user_session\tsynthetic-session\t.github.com\t/\nlogged_in\tyes\t.github.com\t/", JSON.stringify([{ name: "user_session", value: "synthetic-session", domain: ".github.com" }, { name: "unrelated", value: "ignored", domain: ".example.test" }])];
  await stubFetch([], () => { for (const value of inputs) assert.equal(validate(value), undefined); });
});

test("Cookie validation rejects wrong credentials and never echoes them", async () => {
  const validate = value => parseGithubCookie(value).error;
  const invalid = ["session=synthetic-private", "synthetic-private", "user_session=", "user_session=synthetic-private; logged_in=no", "Set-Cookie: user_session=synthetic-private; Path=/", "Cookie: " + valid + "\r\nAuthorization: Bearer synthetic-private", JSON.stringify([{ name: "user_session", value: "synthetic-private", domain: ".example.test" }]), JSON.stringify([{ name: "user_session", value: "synthetic-private; injected=value", domain: "github.com" }]), JSON.stringify({ user_session: "synthetic-private" }), "[broken-synthetic-private", "user_session=synthetic-private\u0000", "user_session=" + "x".repeat(32768), "user_session=" + "词".repeat(11000)];
  await stubFetch([], () => {
    for (const value of invalid) {
      const error = validate(value);
      assert.equal(typeof error, "string", "invalid Cookie accepted");
      assert.ok(error.length > 0);
      assert.ok(!error.includes("synthetic-private"));
    }
  });
});

test("Cookie validation observes the exact UTF-8 byte limit", async () => {
  const validate = value => parseGithubCookie(value).error;
  assert.equal(validate("user_session=" + "x".repeat(32768 - "user_session=".length)), undefined);
  assert.equal(typeof validate("user_session=" + "x".repeat(32769 - "user_session=".length)), "string");
});

test("OAuth guidance and callback errors explain next steps without leaking input", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch(oauthResponses().slice(0, 2), async calls => {
    const flow = await method.authorize({ site: "org", accessToken: "synthetic-access" });
    for (const phrase of ["未自动", "页面未找到", "完整", "刷新"]) assert.ok(flow.instructions.includes(phrase));
    for (const input of ["", "user_session=synthetic-private", "https://agentrouter.org/oauth/github/magpie?error=access_denied&error_description=synthetic-private", "https://agentrouter.org/oauth/github/magpie?code=synthetic-code&state=wrong"]) {
      const result = await flow.callback(input);
      assert.equal(result.type, "failed");
      assert.ok(!hostFailed(result).error.includes("synthetic-private"));
      assert.ok(/重新|完整|授权/.test(hostFailed(result).error));
    }
    assert.equal(calls.length, 2);
  });
});

test("OAuth callback rejects foreign, ambiguous, and malformed URLs without exchanging", async () => {
  const method = methodOf(await plugin(), "oauth");
  const root = "https://agentrouter.org/oauth/github/magpie";
  const query = "?code=synthetic-code&state=synthetic-state";
  const invalid = [
    "https://evil.invalid/oauth/github/magpie" + query,
    "https://agentrouter.org/oauth/github" + query,
    root + "?code=synthetic-code", root + query + "&state=synthetic-state", root + query + "&code=other-code",
    root + "?code=%ZZsynthetic&state=synthetic-state", root + query + "#fragment",
    root + "?code=synthetic-code&state=synthetic-state&error=access_denied",
  ];
  await stubFetch(oauthResponses().slice(0, 2), async calls => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    for (const value of invalid) {
      const result = await flow.callback(value);
      assert.equal(result.type, "failed");
      assert.ok(!hostFailed(result).error.includes("synthetic"));
    }
    assert.equal(calls.length, 2);
  });
  await stubFetch(oauthResponses(), async () => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    assert.equal((await flow.callback(callback)).type, "success");
  });
});

test("OAuth exchange failure does not echo upstream code or session material", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch([...oauthResponses().slice(0, 2), raw({ success: false, message: "synthetic-private code expired" })], async () => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    const result = await flow.callback(callback);
    assert.equal(result.type, "failed");
    assert.ok(!hostFailed(result).error.includes("synthetic-private"));
    assert.match(hostFailed(result).error, /重新/);
    assert.match(hostFailed(result).error, /过期|失效|一次/);
  });
});
