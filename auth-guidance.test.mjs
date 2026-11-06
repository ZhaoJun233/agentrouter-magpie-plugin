import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";

const valid = "user_session=synthetic-session; logged_in=yes";
const raw = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
const applies = (prompt, inputs) => !prompt.when || (prompt.when.op === "eq" ? inputs[prompt.when.key] === prompt.when.value : inputs[prompt.when.key] !== prompt.when.value);
const methodOf = (p, type) => p.auth.methods.find(m => m.type === type);
const cookieField = method => method.prompts.find(p => p.key === "githubCookie");

// Magpie 0.1.2897 host.js failed() contract: message is not consumed.
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

test("Magpie failure adapter preserves safe callback and exchange guidance", async () => {
  const method = methodOf(await plugin(), "oauth");
  for (const scenario of [
    { pasted: "" },
    { pasted: "https://agentrouter.org/oauth/github/magpie?code=synthetic-code&state=wrong" },
    { pasted: "synthetic-code", response: raw({ success: false, message: "synthetic-private expired" }) },
    { pasted: "synthetic-code", response: new Error("synthetic-private network error") },
    { pasted: "synthetic-code", response: raw({ success: true, data: { id: 42 } }), clearToken: true },
  ]) {
    const responses = oauthResponses().slice(0, 2);
    if (scenario.response) responses.push(scenario.response);
    await stubFetch(responses, async () => {
      const inputs = { accessToken: "synthetic-access" };
      const flow = await method.authorize(inputs);
      if (scenario.clearToken) inputs.accessToken = "";
      const result = await flow.callback(scenario.pasted);
      assert.equal(result.type, "failed");
      const visible = hostFailed(result);
      assert.equal(visible.ok, false);
      assert.equal(typeof visible.error, "string", "host must receive actionable error");
      assert.match(visible.error, /重新/);
      assert.ok(!visible.error.includes("synthetic"));
    });
  }
});

test("both login methods offer skip-first conditional Cookie setup", async () => {
  const p = await plugin();
  for (const method of p.auth.methods) {
    const mode = method.prompts.find(p => p.key === "githubCookieMode");
    assert.ok(mode);
    assert.equal(mode.type, "select");
    assert.deepEqual(mode.options.map(o => o.value), ["skip", "configure"]);
    const cookie = cookieField(method);
    assert.ok(!applies(cookie, {}));
    assert.ok(!applies(cookie, { githubCookieMode: "skip" }));
    assert.ok(applies(cookie, { githubCookieMode: "configure" }));
    assert.equal(cookie.type, "pass" + "word");
    assert.equal(cookie.validate(""), undefined);
    assert.equal(cookie.validate("   "), undefined);
  }
  const oauth = methodOf(p, "oauth");
  assert.deepEqual(oauth.prompts.map(p => p.key), ["site", "accessToken", "githubCookieMode", "githubCookie"]);
  for (const method of p.auth.methods) {
    assert.equal(method.prompts.find(p => p.key === "accessToken").type, "pass" + "word");
  }
});

test("Cookie guidance contains browser steps, credential boundaries and safe escape", async () => {
  for (const method of (await plugin()).auth.methods) {
    const message = cookieField(method).message;
    for (const phrase of ["https://github.com", "同一", "开发者工具", "Network", "Request Headers", "Cookie", "Set-Cookie", "HttpOnly", "高权限", "网关", "留空", "聊天"]) {
      assert.ok(message.includes(phrase), "missing guidance: " + phrase);
    }
    assert.ok(message.includes("不能自动"));
  }
});

test("Cookie validation accepts supported formats without network access", async () => {
  const validate = cookieField(methodOf(await plugin(), "oauth")).validate;
  const inputs = [valid, "Cookie: " + valid, "__Host-user_session_same_site=synthetic-host", "user_session\tsynthetic-session\t.github.com\t/\nlogged_in\tyes\t.github.com\t/", JSON.stringify([{ name: "user_session", value: "synthetic-session", domain: ".github.com" }, { name: "unrelated", value: "ignored", domain: ".example.test" }])];
  await stubFetch([], () => { for (const value of inputs) assert.equal(validate(value), undefined); });
});

test("Cookie validation rejects wrong credentials and never echoes them", async () => {
  const validate = cookieField(methodOf(await plugin(), "oauth")).validate;
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
  const validate = cookieField(methodOf(await plugin(), "oauth")).validate;
  assert.equal(validate("user_session=" + "x".repeat(32768 - "user_session=".length)), undefined);
  assert.equal(typeof validate("user_session=" + "x".repeat(32769 - "user_session=".length)), "string");
});

test("OAuth rejects invalid Cookie and unknown mode before requesting state", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch([], async calls => {
    await assert.rejects(() => method.authorize({ site: "org", accessToken: "synthetic-access", githubCookie: "session=synthetic-private" }), /GitHub/);
    await assert.rejects(() => method.authorize({ site: "org", accessToken: "synthetic-access", githubCookieMode: "other" }), /选择/);
    assert.equal(calls.length, 0);
  });
});

test("OAuth saves normalized Cookie, while legacy callers remain supported", async () => {
  const method = methodOf(await plugin(), "oauth");
  for (const inputs of [{ githubCookieMode: "configure", githubCookie: "Cookie: " + valid }, { githubCookie: valid }]) {
    await stubFetch(oauthResponses(), async calls => {
      const flow = await method.authorize({ site: "org", accessToken: "synthetic-access", ...inputs });
      const result = await flow.callback("https://agentrouter.org/oauth/github/magpie?code=synthetic-code&state=synthetic-state");
      assert.equal(result.type, "success");
      assert.equal(result.metadata.githubCookie, valid);
      assert.ok(calls.every(c => !new Headers(c.init.headers).get("Cookie")?.includes("user_session")));
    });
  }
});

test("OAuth explicit skip clears hidden input and empty configure still signs in", async () => {
  const method = methodOf(await plugin(), "oauth");
  for (const inputs of [{ githubCookieMode: "skip", githubCookie: "hidden-private" }, { githubCookieMode: "configure", githubCookie: "" }]) {
    await stubFetch(oauthResponses(), async () => {
      const flow = await method.authorize({ site: "org", accessToken: "synthetic-access", ...inputs });
      const result = await flow.callback("synthetic-code");
      assert.equal(result.type, "success");
      assert.equal(result.metadata.githubCookie, "");
      assert.equal({ ...inputs, ...result.metadata }.githubCookie, "");
    });
  }
});

test("Magpie API finalization preserves host key ownership and canonicalizes metadata", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  await stubFetch([], async () => {
    const inputs = { githubCookie: "Cookie: " + valid, githubCookieMode: "configure", accessToken: "synthetic-access" };
    const result = await method.authorize(inputs);
    assert.equal(result.type, "success");
    assert.ok(!Object.hasOwn(result, "key"));
    const metadata = { ...inputs, ...result.metadata };
    assert.equal(metadata.githubCookie, valid);
    assert.equal(result.key ?? "host-supplied-api-key", "host-supplied-api-key");
    const skip = await method.authorize({ githubCookieMode: "skip", githubCookie: "hidden-private" });
    assert.equal(skip.metadata.githubCookie, "");
    await assert.rejects(() => method.authorize({ githubCookie: "session=synthetic-private" }), /GitHub/);
  });
});

test("hosts without Magpie retain native API-key entry without a finalize hook", async () => {
  assert.equal(methodOf(await plugin(), "api").authorize, undefined);
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

test("API finalization keeps all host metadata and ignores hidden skip values", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  const inputs = { site: "air", endpoint: "https://example.invalid", userId: "42", accessToken: "synthetic-access", cookie: "session=synthetic-site", username: "legacy-user", githubCookieMode: "skip", githubCookie: "x".repeat(33 * 1024) };
  const original = { ...inputs };
  await stubFetch([], async calls => {
    const result = await method.authorize(inputs);
    assert.equal(result.type, "success");
    assert.deepEqual(result.metadata, { ...inputs, githubCookie: "" });
    assert.equal(Object.hasOwn(result, "key"), false);
    assert.deepEqual(inputs, original);
    assert.equal(calls.length, 0);
  });
});

test("Cookie finalization filters foreign export domains across supported formats", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  for (const cookie of [
    "Name\tValue\tDomain\nuser_session\tsynthetic-session\t.github.com\nforeign\tsynthetic-private\telsewhere.invalid\nlogged_in\tyes\tgithub.com",
    JSON.stringify([{ name: "user_session", value: "synthetic-session", domain: ".github.com" }, { name: "foreign", value: "synthetic-private", domain: "github.com.evil.invalid" }, { name: "logged_in", value: "yes", domain: "github.com" }]),
  ]) {
    const result = await method.authorize({ githubCookieMode: "configure", githubCookie: cookie });
    assert.equal(result.metadata.githubCookie, valid);
  }
});

test("Cookie parser refuses empty sessions, nonstring rows, and control characters", async () => {
  const method = methodOf(await plugin({ magpie: {} }), "api");
  const invalid = [
    "user_session=", "user_session=synthetic; user_session=", "__Host-user_session_same_site=", "user_session=synthetic; logged_in=no",
    "user_session=synthetic\u0000", "user_session=synthetic\u007f", "user_session=synthetic\t",
    JSON.stringify([{ name: "user_session", value: "synthetic\r\nInjected: yes", domain: ".github.com" }]),
    JSON.stringify([{ name: "user_session", value: 123, domain: ".github.com" }]),
    JSON.stringify([{ name: "user_session", value: "synthetic", domain: "sub.github.com" }]),
    "[invalid-json", "{\"user_session\":\"synthetic\"}",
  ];
  await stubFetch([], async calls => {
    for (const cookie of invalid) {
      const message = cookieField(method).validate(cookie);
      assert.equal(typeof message, "string", "prompt rejects malformed input");
      await assert.rejects(method.authorize({ githubCookie: cookie }), error => error.message === message);
      assert.ok(!message.includes("synthetic"));
    }
    assert.equal(calls.length, 0);
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
    assert.equal((await flow.callback("synthetic-code")).type, "success");
  });
});

test("OAuth exchange failure does not echo upstream code or session material", async () => {
  const method = methodOf(await plugin(), "oauth");
  await stubFetch([...oauthResponses().slice(0, 2), raw({ success: false, message: "synthetic-private code expired" })], async () => {
    const flow = await method.authorize({ accessToken: "synthetic-access" });
    const result = await flow.callback("synthetic-code");
    assert.equal(result.type, "failed");
    assert.ok(!hostFailed(result).error.includes("synthetic-private"));
    assert.match(hostFailed(result).error, /重新/);
    assert.match(hostFailed(result).error, /过期|失效|一次/);
  });
});
