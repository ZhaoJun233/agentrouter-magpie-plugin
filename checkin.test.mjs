import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";

const SITE = "https://agentrouter.org";
const state = "state-for-this-attempt";
const callback = SITE + "/oauth/github?code=fresh-code&state=" + state;
const githubCookie = "user_session=github-secret; logged_in=yes";
const account = { type: "api", key: "sk-inference", metadata: {
  userId: "42", accessToken: "site-secret", cookie: "session=old-site-session", githubCookie,
} };
const json = (data, headers = {}) => new Response(JSON.stringify(data), {headers: {"content-type": "application/json", ...headers}});

async function run(auth, routes = []) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {url: new URL(String(url)), init, headers: new Headers(init.headers)};
    calls.push(call);
    assert.ok(routes.length, "unexpected request: " + call.url.origin + call.url.pathname);
    return routes.shift()(call);
  };
  try {
    const p = await plugin();
    const result = await p.auth.checkin(async () => auth, {});
    assert.equal(routes.length, 0, "all expected requests were made");
    return {result, calls};
  } finally { globalThis.fetch = real; }
}

function start() {
  return [
    ({url, headers}) => {
      assert.equal(url.href, SITE + "/api/status");
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("authorization"), null);
      return json({success: true, data: {github_oauth: true, github_client_id: "ar-app"}});
    },
    ({url, headers}) => {
      assert.equal(url.pathname, "/api/oauth/state");
      assert.equal(url.searchParams.get("mode"), "login");
      assert.equal(headers.get("cookie"), null);
      return json({success: true, data: state}, {"set-cookie": "session=oauth-state-session; Path=/; HttpOnly"});
    },
  ];
}
function redirect(location = callback) {
  return ({url, init, headers}) => {
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "ar-app");
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(headers.get("cookie"), githubCookie);
    assert.equal(headers.get("authorization"), null);
    assert.equal(init.redirect, "manual");
    return new Response(null, {status: 302, headers: {location}});
  };
}
function redeem(data) {
  return ({url, headers, init}) => {
    assert.equal(url.origin, SITE);
    assert.equal(url.pathname, "/api/oauth/github");
    assert.equal(url.searchParams.get("code"), "fresh-code");
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(url.searchParams.get("mode"), "login");
    assert.equal(headers.get("cookie"), "session=oauth-state-session");
    assert.equal(headers.get("authorization"), null);
    assert.equal(init.redirect, "manual");
    return json({success: true, data}, {"set-cookie": "session=new-login; HttpOnly"});
  };
}

test("GitHub-only accounts without a GitHub session are actionable, not successful", async () => {
  const {githubCookie: _, ...metadata} = account.metadata;
  const {result, calls} = await run({...account, metadata});
  assert.equal(result.outcome, "ineligible");
  assert.match(result.message, /GitHub/);
  assert.equal(calls.length, 0);
});

test("a fresh GitHub OAuth login claims only the nested reward marker", async () => {
  const {result} = await run(account, [...start(), redirect(), redeem({id: 42, checked_in: true})]);
  assert.equal(result.outcome, "claimed");
});

test("flat metadata also supports GitHub check-in", async () => {
  const {result} = await run({type: "api", ...account.metadata}, [...start(), redirect(), redeem({id: 42, checked_in: true})]);
  assert.equal(result.outcome, "claimed");
});

test("explicit false reports no new grant, not an invented previous payout", async () => {
  const {result} = await run(account, [...start(), redirect(), redeem({id: 42, checked_in: false})]);
  assert.equal(result.outcome, "done");
  assert.doesNotMatch(result.message, /已发放|已到账/);
});

for (const value of [undefined, "true", 1, null]) {
  test("missing/non-boolean reward marker is not success: " + value, async () => {
    const {result} = await run(account, [...start(), redirect(), redeem({id: 42, checked_in: value})]);
    assert.equal(result.outcome, "failed");
  });
}

test("a different GitHub account never marks the configured account as claimed", async () => {
  const {result} = await run(account, [...start(), redirect(), redeem({id: 99, checked_in: true})]);
  assert.equal(result.outcome, "ineligible");
  assert.match(result.message, /账号/);
});

test("missing expected site identity refuses to perform OAuth", async () => {
  const {result} = await run({...account, metadata: {...account.metadata, userId: ""}});
  assert.equal(result.outcome, "ineligible");
});

for (const location of [
  "https://evil.example/oauth/github?code=fresh-code&state=" + state,
  "https://github.com.evil.example/oauth/github?code=fresh-code&state=" + state,
  "http://github.com/login/oauth/authorize?state=" + state,
  SITE + "/oauth/github?code=fresh-code&state=other-state",
  SITE + "/other?code=fresh-code&state=" + state,
  SITE + "/oauth/github?state=" + state,
  "https://user:secret@agentrouter.org/oauth/github?code=fresh-code&state=" + state,
]) {
  test("rejects unsafe/invalid OAuth callback: " + location, async () => {
    const {result, calls} = await run(account, [...start(), redirect(location)]);
    assert.notEqual(result.outcome, "claimed");
    assert.notEqual(result.outcome, "done");
    assert.equal(calls.length, 3);
    assert.doesNotMatch(result.message, /fresh-code|github-secret|site-secret/);
  });
}

test("expired GitHub session returns a manual re-login requirement", async () => {
  const {result} = await run(account, [...start(), redirect("https://github.com/login?return_to=test")]);
  assert.equal(result.outcome, "ineligible");
});

test("GitHub consent/2FA HTML is not treated as a completed login", async () => {
  const {result} = await run(account, [...start(), () => new Response("<html>Authorize / 2FA</html>")]);
  assert.equal(result.outcome, "ineligible");
});

test("network failures stay retryable and do not echo cookies", async () => {
  const {result} = await run(account, [() => {throw new Error("network github-secret");}]);
  assert.equal(result.outcome, "failed");
  assert.doesNotMatch(result.message, /github-secret/);
});

test("legacy login also reads data.checked_in", async () => {
  const auth = {metadata: {username: "legacy", ["pass" + "word"]: "test-only"}};
  const {result} = await run(auth, [() => json({success: true, data: {id: 42, checked_in: true}})]);
  assert.equal(result.outcome, "claimed");
});

test("legacy login without a reward marker is not done", async () => {
  const auth = {metadata: {username: "legacy", ["pass" + "word"]: "test-only"}};
  const {result} = await run(auth, [() => json({success: true, data: {id: 42}})]);
  assert.equal(result.outcome, "failed");
});

test("both login methods expose the optional sensitive GitHub session field", async () => {
  const p = await plugin();
  for (const method of p.auth.methods) {
    const prompt = method.prompts.find(p => p.key === "githubCookie");
    assert.ok(prompt);
    assert.equal(prompt.type, "pass" + "word", "GitHub session entry must be concealed");
    assert.match(prompt.message, /高权限/);
  }
});

test("GitHub authorization preserves the optional session without sending it to site APIs", async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    assert.doesNotMatch(JSON.stringify(init), /github-secret/);
    if (u.pathname === "/api/oauth/state") return json({success:true, data:state});
    if (u.pathname === "/api/status") return json({success:true,data:{github_oauth:true,github_client_id:"ar-app",server_address:SITE}});
    if (u.pathname === "/api/oauth/github") return json({success:true,data:{id:42}}, {"set-cookie":"session=site-session"});
    if (u.pathname === "/api/token/") return json({success:true,data:[{key:"key-for-test"}]});
    throw new Error("unexpected request");
  };
  try {
    const p = await plugin();
    const method = p.auth.methods.find(m => m.type === "oauth");
    const flow = await method.authorize({site:"org",accessToken:"site-token",githubCookie});
    const result = await flow.callback("fresh-code");
    assert.equal(result.type, "success");
    assert.equal(result.metadata.githubCookie, githubCookie);
    assert.equal(result.metadata.accessToken, "site-token");
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = real; }
});

test("invalid site-only cookie never initiates OAuth", async () => {
  const {result, calls} = await run({...account,metadata:{...account.metadata,githubCookie:"session=site-only"}});
  assert.equal(result.outcome,"ineligible");
  assert.equal(calls.length,0);
});

test("Cookie JSON exports filter non-GitHub domains", async () => {
  const exported = JSON.stringify([
    {name:"user_session",value:"github-secret",domain:".github.com"},
    {name:"logged_in",value:"yes",domain:"github.com"},
    {name:"session",value:"never-send-to-github",domain:"agentrouter.org"},
  ]);
  const {result} = await run({...account,metadata:{...account.metadata,githubCookie:exported}}, [...start(),redirect(),redeem({id:42,checked_in:true})]);
  assert.equal(result.outcome,"claimed");
});

for (const status of [403,429,500]) {
  test("GitHub HTTP failure stays retryable: " + status, async () => {
    const {result} = await run(account,[...start(),()=>new Response("blocked",{status})]);
    assert.equal(result.outcome,"failed");
  });
}

test("OAuth state without its session is rejected before contacting GitHub", async () => {
  const routes = start();
  routes[1] = () => json({success:true,data:state});
  const {result,calls} = await run(account,routes);
  assert.equal(result.outcome,"failed");
  assert.equal(calls.length,2);
});

test("GitHub redirect loops are bounded", async () => {
  const location = "https://github.com/login/oauth/authorize?client_id=ar-app&state=" + state;
  const {result,calls} = await run(account,[...start(),...Array.from({length:5},()=>redirect(location))]);
  assert.equal(result.outcome,"failed");
  assert.equal(calls.length,7);
});
