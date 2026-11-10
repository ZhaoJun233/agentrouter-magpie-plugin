import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";
import { parseGithubCookie } from "./github-cookie.mjs";

const valid = "user_session=synthetic-session; logged_in=yes";
const callback = "https://agentrouter.org/oauth/github/magpie?code=synthetic-code&state=synthetic-state";
const raw = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
const methodOf = (p, type) => p.auth.methods.find(m => m.type === type);
const githubOf = (p) => p.auth.methods[1];
const systemTokenOf = (p) => p.auth.methods[2];
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

test("first login collects the site selection, the system token and the key choice", async () => {
  const p = await plugin({ magpie: {} });
  assert.deepEqual(p.auth.methods.map(m => m.type), ["api", "oauth", "oauth"]);
  assert.deepEqual(methodOf(p, "api").prompts.map(p => p.key), ["site"]);
  assert.deepEqual(githubOf(p).prompts.map(p => p.key), ["site", "accessToken"]);
  const token = githubOf(p).prompts[1];
  assert.equal(token.type, "password");
  assert.equal(token.validate("synthetic-access"), undefined);
  assert.ok(token.validate(" "));
  assert.match(token.message, /不是模型 API Key/);
  const entry = systemTokenOf(p);
  assert.deepEqual(entry.prompts.map(p => p.key), ["site", "accessToken", "userId", "modelKeyId"]);
  assert.equal(entry.prompts[1].type, "password");
  assert.equal(entry.prompts[2].type, "text");
  assert.equal(entry.prompts[3].type, "text");
  assert.equal(entry.prompts[2].validate("42"), undefined);
  assert.equal(entry.prompts[2].validate(" 7 "), undefined);
  for (const bad of ["", " ", "0", "42.5", "-1", "1e3", "abc"]) assert.ok(entry.prompts[2].validate(bad), `user id ${bad} accepted`);
  assert.equal(entry.prompts[3].validate("15"), undefined);
  assert.equal(entry.prompts[3].validate(""), undefined);
  assert.equal(entry.prompts[3].validate(" "), undefined);
  for (const bad of ["0", "1.5", "abc"]) assert.ok(entry.prompts[3].validate(bad), `key id ${bad} accepted`);
});

test("API finalization is local and leaves the host as sole key owner", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  await stubFetch([], async calls => {
    const inputs = { site: "air", githubCookie: "synthetic-private", accessToken: "synthetic-access" };
    const before = structuredClone(inputs);
    const result = await method.authorize(inputs);
    assert.deepEqual(result, { type: "success", metadata: { site: "air", apiBase: "https://ps.air-outer.com/v1" } });
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
  const method = githubOf(await plugin(), "oauth");
  await stubFetch(oauthResponses(), async calls => {
    const inputs = { accessToken: "synthetic-access", githubCookie: valid, site: "air", headers: "X-Private: ignored" };
    const flow = await method.authorize(inputs);
    inputs.accessToken = "changed-private";
    const result = await flow.callback(callback);
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-api-key");
    assert.deepEqual(result.metadata, { site: "air", apiBase: "https://ps.air-outer.com/v1", accessToken: "synthetic-access", userId: "42", cookie: "session=synthetic-site" });
    assert.ok(calls.every(c => c.url.startsWith("https://ps.air-outer.com/")));
    assert.ok(calls.every(c => !new Headers(c.init.headers).has("Cookie")));
    assert.equal(new Headers(calls[3].init.headers).get("Authorization"), "synthetic-access");
  });
});

test("OAuth bare codes and exchange network errors fail safely", async () => {
  const method = githubOf(await plugin());
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

test("OAuth guidance and callback errors explain next steps without leaking inputs", async () => {
  const method = githubOf(await plugin());
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
  const method = githubOf(await plugin());
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
  const method = githubOf(await plugin());
  await stubFetch([...oauthResponses().slice(0, 2), raw({ success: false, message: "synthetic-private code expired" })], async () => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    const result = await flow.callback(callback);
    assert.equal(result.type, "failed");
    assert.ok(!hostFailed(result).error.includes("synthetic-private"));
    assert.match(hostFailed(result).error, /重新/);
    assert.match(hostFailed(result).error, /过期|失效|一次/);
  });
});

test("system token sign-in reads the account's keys without a provider code", async () => {
  const p = await plugin({ magpie: {} });
  const method = systemTokenOf(p);
  for (const inputs of [{ site: "air", accessToken: "synthetic-access" }, { site: "air", accessToken: "synthetic-access", userId: "0" }, { site: "air", accessToken: "synthetic-access", userId: "  " }]) {
    await stubFetch([], async calls => {
      const result = await method.authorize(inputs);
      assert.equal(result.type, "failed");
      assert.equal(calls.length, 0);
    });
  }
  await stubFetch([raw({ success: true, data: { items: [{ status: 1, key: "synthetic-model-key" }], total: 1 } })], async calls => {
    const flow = await method.authorize({ site: "air", accessToken: "synthetic-access", userId: "42" });
    assert.equal(flow.method, "auto");
    assert.ok(!new URL(flow.url).searchParams.has("code"));
    const result = await flow.callback(undefined);
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-model-key");
    assert.deepEqual(result.metadata, {
      site: "air",
      apiBase: "https://ps.air-outer.com/v1",
      accessToken: "synthetic-access",
      userId: "42",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ps.air-outer.com/api/token/?p=1&page_size=50");
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "synthetic-access");
    assert.equal(new Headers(calls[0].init.headers).get("New-Api-User"), "42");
  });
});

test("system token sign-in rejects invalid Key IDs before creating a flow or making requests", async () => {
  const p = await plugin({ magpie: {} });
  const method = systemTokenOf(p);
  const prompt = method.prompts.find(p => p.key === "modelKeyId");
  for (const site of ["org", "air"]) {
    for (const modelKeyId of ["../other", "%2e%2e/other", "9/child", "9?view=all", "9#part", "0", "-1", "1.5", "abc", "９"]) {
      await stubFetch([], async calls => {
        assert.ok(prompt.validate(modelKeyId));
        const result = await method.authorize({ site, accessToken: "synthetic-access", userId: "42", modelKeyId });
        assert.equal(result.type, "failed", `${site}: invalid Key ID must fail at authorization`);
        assert.match(hostFailed(result).error, /模型 Key ID/);
        assert.ok(!hostFailed(result).error.includes("synthetic-access"));
        assert.equal(result.callback, undefined);
        assert.equal(result.key, undefined);
        assert.equal(calls.length, 0);
      });
    }
  }
});

test("system token sign-in normalizes optional numeric Key IDs", async () => {
  const p = await plugin({ magpie: {} });
  const method = systemTokenOf(p);
  for (const site of ["org", "air"]) {
    for (const modelKeyId of [undefined, null, "", "   ", " 9 ", 9]) {
      const requested = String(modelKeyId ?? "").trim();
      const item = { id: 9, status: 1, key: "synthetic-model-key" };
      await stubFetch([raw({ success: true, data: requested ? item : { items: [item], total: 1 } })], async calls => {
        const flow = await method.authorize({ site, accessToken: "synthetic-access", userId: "42", modelKeyId });
        const result = await flow.callback();
        assert.equal(result.type, "success");
        assert.equal(result.key, item.key);
        assert.equal(calls.length, 1);
        const origin = site === "air" ? "https://ps.air-outer.com" : "https://agentrouter.org";
        assert.equal(calls[0].url, origin + (requested ? "/api/token/9" : "/api/token/?p=1&page_size=50"));
      });
    }
  }
});

test("system token sign-in asks for a Key ID when the account has more than one", async () => {
  const p = await plugin({ magpie: {} });
  const method = systemTokenOf(p);
  await stubFetch([raw({ success: true, data: { items: [
    { id: 7, status: 1, key: "synthetic-one" },
    { id: 9, status: 1, key: "synthetic-two" },
  ], total: 2 } })], async calls => {
    const flow = await method.authorize({ site: "org", accessToken: "synthetic-access", userId: "3" });
    const result = await flow.callback();
    assert.equal(result.type, "failed");
    assert.match(hostFailed(result).error, /模型 Key ID/);
    assert.equal(calls.length, 1);
  });
  await stubFetch([raw({ success: true, data: { id: 9, status: 1, key: "synthetic-two" } })], async calls => {
    const flow = await method.authorize({ site: "org", accessToken: "synthetic-access", userId: "3", modelKeyId: "9" });
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.key, "synthetic-two");
    assert.equal(calls.length, 1, "a named id reads that key alone");
    assert.equal(calls[0].url, "https://agentrouter.org/api/token/9");
    assert.deepEqual(result.metadata, { site: "org", accessToken: "synthetic-access", userId: "3" });
  });
  await stubFetch([raw({ success: true, data: { id: 9, status: 2, key: "synthetic-disabled" } })], async calls => {
    const flow = await method.authorize({ site: "org", accessToken: "synthetic-access", userId: "3", modelKeyId: "9" });
    assert.equal((await flow.callback()).type, "failed");
    assert.equal(calls.length, 1);
  });
});

test("system token sign-in failures never echo the token or save a key", async () => {
  const p = await plugin({ magpie: {} });
  const method = systemTokenOf(p);
  for (const [response, said] of [
    [raw({ success: true, data: { items: [] } }), "未找到"],
    [raw({ success: true, data: { items: [{ status: 1, key: "agentrouter" }] } }), "未找到"],
    [raw({ success: false, message: "synthetic-private token rejected" }), "拒绝"],
    [new Response("too many requests", { status: 429 }), "暂时"],
    [new Response("<html>synthetic-private</html>", { status: 403 }), "验证页"],
  ]) {
    await stubFetch([response], async calls => {
      const flow = await method.authorize({ site: "air", accessToken: "synthetic-access", userId: "42" });
      const result = await flow.callback();
      assert.equal(result.type, "failed");
      assert.match(hostFailed(result).error, new RegExp(said));
      assert.ok(!hostFailed(result).error.includes("synthetic-private"));
      assert.ok(!hostFailed(result).error.includes("synthetic-access"));
      assert.equal(calls.length, 1);
    });
  }
  await stubFetch([new Error("synthetic-private boom")], async calls => {
    const flow = await method.authorize({ site: "air", accessToken: "synthetic-access", userId: "42" });
    const result = await flow.callback();
    assert.equal(result.type, "failed");
    assert.ok(!hostFailed(result).error.includes("synthetic-private"));
    assert.equal(calls.length, 1);
  });
});
