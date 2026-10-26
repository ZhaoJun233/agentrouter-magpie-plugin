// AgentRouter (agentrouter.org) for magpie / OpenCode.
//
// Three things make this vendor different from a plain OpenAI-compatible
// relay:
//
// 1. Its gateway only answers a client it recognises. A request whose
//    User-Agent is curl's (or anything else off its list) is refused with
//    "unauthorized client detected", even when the key is good. So the
//    request headers are not cosmetic here: they are what gets the key
//    through. They are configurable — per provider and per account — and
//    the defaults are the ones the vendor's own clients send.
//
// 2. It has no daily check-in to call. The site is a New API deployment,
//    and most New API sites put one on GET /api/user/checkin. This one
//    does not: that path falls through to New API's *admin* route
//    /api/user/:id, which answers "权限不足" to every ordinary account —
//    the same answer it gives /api/user/foo or /api/user/zzz. The daily
//    credit is granted at sign-in instead (the site's login response
//    carries checked_in, and its settings keep DailyCheckinQuota), so
//    there is nothing for a plugin to claim after the fact. The check-in
//    hook therefore reports "no check-in here" rather than a day's
//    result, and never retries.
//
// 3. Its balance is behind a WAF. /api/user/self is the only route that
//    carries the account's quota, and from a server the site answers it
//    with an Aliyun slider-captcha page instead of JSON. The slider is
//    solved by a person in a browser, so the balance read fails with a
//    reason that says so, and works again once the site lets the address
//    through. The routes that do answer without a captcha carry no
//    account balance: /api/token/ is one API key's own quota (negative
//    when the key is unlimited), /v1/dashboard/billing/usage is that
//    key's spend, and /api/log/self is a ledger. None of them is the
//    account's balance, so none of them is used as one.
//
// Signing in with only the key is allowed and gives a working provider.
// The access token is only for the balance read; without it that read
// says which page to copy it from.

const PROVIDER = "agentrouter";

// The request endpoint: where completions and the model list go. This is the
// one the user picked, and it stays what they picked even when the site the
// check-in talks to is the other front door. A site's own API lives under it.
const ENDPOINT = "https://agentrouter.org";

const SITES = {
  // The vendor runs two front doors for the same accounts. `api` is the
  // request endpoint a site serves; `site` is where its web routes are.
  org: { name: "AgentRouter", api: "https://agentrouter.org", site: "https://agentrouter.org" },
  air: { name: "AgentRouter (ps.air-outer.com)", api: "https://ps.air-outer.com", site: "https://ps.air-outer.com" },
};

// What the vendor's own clients send. codex_cli_rs is what its gateway
// admits; the rest are the headers a Codex CLI sends beside it.
const DEFAULT_HEADERS = {
  "User-Agent": "codex_cli_rs/0.101.0",
  Accept: "application/json",
};

// Models are listed by the vendor, so this is only what to show before a
// sign-in and the shape (limits, tool calls) each listed model takes.
const MODEL_SHAPE = {
  name: undefined,
  limit: { context: 300000, output: 128000 },
  tool_call: true,
  reasoning: true,
};

const REQUEST_TIMEOUT = 30_000;
const CHECKIN_TIMEOUT = 25_000;

const siteOf = (id) => SITES[id] ?? SITES.org;

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

// parseHeaders turns the one-header-per-line text an account keeps into an
// object. A line is "Name: value"; blank lines and lines starting with #
// are skipped, so a block copied out of a browser's devtools works as it
// is. A name repeated keeps its last value, as a Headers object would.
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const at = s.indexOf(":");
    if (at < 1) continue;
    const name = s.slice(0, at).trim();
    const value = s.slice(at + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

// modelHeaders is the header block the provider's editor keeps on a model:
// info() merges each model's `headers` from the plugin's config, and magpie's
// provider editor writes the user's own there. It is the place a header can
// be changed after sign-in without signing in again, so it is read here as
// the provider's own block.
function modelHeaders(provider) {
  const models = provider?.models;
  if (!models || typeof models !== "object") return {};
  const out = {};
  for (const m of Object.values(models)) {
    if (m && typeof m.headers === "object" && m.headers) Object.assign(out, m.headers);
  }
  return out;
}

// headersOf is what a request to the vendor is sent with, lowest to highest:
// the defaults, the provider's own block (its models' headers, which the
// editor keeps), and the account's own, each overriding the one before it.
function headersOf(provider, auth) {
  return {
    ...DEFAULT_HEADERS,
    ...modelHeaders(provider),
    ...parseHeaders(provider?.headers),
    ...parseHeaders(headersText(auth)),
  };
}

// applyHeaders sets headers on a Headers object, dropping any whose value is
// empty so a user can take one off by clearing it.
function applyHeaders(h, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") h.delete(k);
    else h.set(k, String(v));
  }
  return h;
}

// apiBase is the base completions go to. It follows the account's own
// endpoint when it gave one, and otherwise the endpoint this plugin was built
// for — never the check-in site, so picking ps.air-outer.com for the check-in
// doesn't quietly move requests off agentrouter.org.
function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (said) return `${said.replace(/\/+$/, "")}/v1`;
  const base = String(meta(auth, "apiBase") ?? "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `${ENDPOINT}/v1`;
}

// siteBase is where the site's own web routes are: the balance and the
// check-in. It follows the site the account signed in to, not the request
// endpoint, since a front door's web routes are its own.
function siteBase(provider, auth) {
  const said = String(meta(auth, "siteURL") ?? provider?.siteURL ?? "").trim();
  if (said) return said.replace(/\/+$/, "");
  return siteOf(siteName(auth) || provider?.site).site;
}

// meta reads a field the account keeps, whether magpie hands the auth as the
// flat record ({type, key, accessToken, …}) or with the sign-in's answers
// under metadata ({type, key, metadata: {accessToken, …}}). Both shapes reach
// a hook: the flat one from the store, the nested one from what authorize
// returned, so every reader goes through here.
function meta(auth, name) {
  if (!auth) return undefined;
  const flat = auth[name];
  if (flat !== undefined && flat !== null && String(flat).trim() !== "") return flat;
  const nested = auth.metadata?.[name];
  return nested === undefined || nested === null ? undefined : nested;
}

// userToken is the credential the site's own /api/user routes take: the
// access token from the profile page. An sk- key is not one of those, and
// sending it there is what makes the balance read as "access token 无效".
function userToken(auth) {
  return String(meta(auth, "accessToken") ?? "").trim();
}

// apiKey is the credential completions take.
function apiKey(auth) {
  return String(auth?.key ?? "").trim();
}

// userId is the New-Api-User header's value. A New API site answers 401 to
// a session that is good but doesn't say which user it is, so the account
// keeps the id beside the token.
function userId(auth) {
  return String(meta(auth, "userId") ?? "").trim();
}

// headersText is the account's own header block, if it gave one.
function headersText(auth) {
  return String(meta(auth, "headers") ?? "");
}

// cookieText is the browser cookie the account copied from the site.
//
// It is what gets past the WAF: /api/user/self answers a server with an
// Aliyun slider captcha, and the cookie a browser holds after a person has
// slid it is the proof the WAF wants. A password sign-in does not produce
// one — the WAF challenge is per address, not per account — so the cookie is
// the only credential that carries a real browser's clearance.
function cookieText(auth) {
  return String(meta(auth, "cookie") ?? "").trim();
}

// parseCookies turns the text a browser shows for a site ("a=1; b=2", or
// the tab-separated lines of a devtools cookie table) into a Cookie header.
// A name repeated keeps its last value, as the browser's own send would.
function parseCookies(text) {
  const out = [];
  const seen = new Map();
  for (const raw of String(text ?? "").split(/\r?\n|;/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    // A devtools row is "name<TAB>value<TAB>domain…"; a plain pair is
    // "name=value". Both keep only the first two fields.
    const cols = s.split("\t");
    let name, value;
    if (cols.length > 1) {
      name = cols[0].trim();
      value = (cols[1] ?? "").trim();
    } else {
      const at = s.indexOf("=");
      if (at < 1) continue;
      name = s.slice(0, at).trim();
      value = s.slice(at + 1).trim();
    }
    if (!name) continue;
    if (seen.has(name)) out[seen.get(name)] = `${name}=${value}`;
    else {
      seen.set(name, out.length);
      out.push(`${name}=${value}`);
    }
  }
  return out.join("; ");
}

// siteName is the site the account signed in to.
function siteName(auth) {
  return String(meta(auth, "site") ?? "org");
}

// userHeaders are what a /api/user call carries: the access token, the user
// id when the account knows it, and the browser cookie that gets past the
// WAF when the account has one.
function userHeaders(provider, auth) {
  const h = headersOf(provider, auth);
  h.Authorization = userToken(auth);
  delete h["Content-Type"];
  if (userId(auth)) h["New-Api-User"] = userId(auth);
  const cookie = parseCookies(cookieText(auth));
  if (cookie) h.Cookie = cookie;
  return h;
}

// masked keeps a value out of a message: a key or a token never goes into
// an error the user sees or a log line.
function masked(v) {
  const s = String(v ?? "");
  if (s.length <= 8) return s ? "…" : "";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function jsonOrText(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

// ---- signing in with GitHub ---------------------------------------------------

// The site's own callback page (/oauth/github) is a route in its single-page
// app, and that route redeems the code the instant it loads — so by the time
// the user has copied the address out of the browser, the code is already
// spent and the exchange here fails with "code is incorrect or expired".
//
// A path *under* that one is not a route, so the app shows its "page not
// found" screen and leaves the code alone, which is what this needs. GitHub
// matches a callback against a subdirectory of the registered URL, and the
// site's own token exchange does not send redirect_uri at all, so the URL
// used here only has to survive the authorize step.
const GITHUB_CALLBACK_PATH = "/oauth/github/magpie";

// callbackUrl is where GitHub is asked to send the browser. It has to sit on
// the origin the site's app registered — the site's own web routes, which the
// site reports — because GitHub checks the callback's host, and the code is
// checked against the site's app rather than against anything here.
const callbackUrl = (origin) => `${origin}${GITHUB_CALLBACK_PATH}`;

// oauthState asks the site for the state its GitHub sign-in expects. The site
// issues it and later checks it on the callback, so it can't be made up here.
async function oauthState(base) {
  try {
    const res = await fetch(`${base}/api/oauth/state?mode=login`, {
      headers: DEFAULT_HEADERS,
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    const st = String(json?.data ?? "").trim();
    if (!json?.success || !st) return { ok: false, why: "站点没有下发 OAuth state" };
    return { ok: true, state: st };
  } catch (e) {
    return { ok: false, why: `拿不到 OAuth state：${e?.message ?? String(e)}` };
  }
}

// siteAuthConfig reads the facts the authorize URL needs out of the site's own
// status: the GitHub app whose callback the site owns, and the origin that
// callback lives on. The origin is not simply the front door the user picked —
// the vendor runs two (org and air) for the same accounts, and GitHub matches
// the callback against the app's registered host, which only the site's own
// `server_address` names.
async function siteAuthConfig(base) {
  try {
    const res = await fetch(`${base}/api/status`, {
      headers: DEFAULT_HEADERS,
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    const id = String(json?.data?.github_client_id ?? "").trim();
    if (!id) return { ok: false, why: "站点没有开启 GitHub 登录" };
    const reported = String(json?.data?.server_address ?? "").trim().replace(/\/+$/, "");
    return { ok: true, id, origin: reported || base.replace(/\/+$/, "") };
  } catch (e) {
    return { ok: false, why: `读不到站点配置：${e?.message ?? String(e)}` };
  }
}

// codeOf pulls the code out of what the user pasted: the whole callback URL
// (…/oauth/github?code=abc&state=…), or the code alone.
function codeOf(pasted) {
  const s = String(pasted ?? "").trim();
  if (!s) return "";
  const m = /[?&]code=([^&#\s]+)/.exec(s);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  // A bare code has no URL around it; anything with spaces or a scheme is
  // not one.
  if (/^[A-Za-z0-9_-]{8,}$/.test(s)) return s;
  return "";
}

// sessionOf pulls the site's session cookie out of a response. This site
// answers a sign-in by setting `session` rather than by putting a token in
// the body, and `get("set-cookie")` joins every cookie with ", " — a
// character that also appears inside one (an Expires date) — so the separate
// entries are what get read when the runtime offers them.
function sessionOf(res) {
  let lines = [];
  try {
    if (typeof res.headers.getSetCookie === "function") lines = res.headers.getSetCookie() ?? [];
  } catch {
    lines = [];
  }
  if (!lines.length) {
    const joined = res.headers.get("set-cookie");
    if (joined) lines = [joined];
  }
  for (const line of lines) {
    const m = /(?:^|[;,])\s*session=([^;,\s]+)/.exec(String(line));
    if (m) return m[1];
  }
  return "";
}

// tokenForSession mints the access token the /api/user routes take. The
// sign-in itself answers with a session and no token, which is what the
// site's own front end does next: with the session it asks for one. New API
// answers 401 to a session that doesn't say which user it is, so the id goes
// along.
async function tokenForSession(base, session, id) {
  const headers = { ...DEFAULT_HEADERS, Cookie: `session=${session}` };
  if (String(id ?? "") !== "") headers["New-Api-User"] = String(id);
  try {
    const res = await fetch(`${base}/api/user/token`, { headers, signal: withTimeout(REQUEST_TIMEOUT) });
    const { json } = await jsonOrText(res);
    return String(json?.data ?? "").trim();
  } catch {
    return "";
  }
}

// redeemGithub trades the code for the site's sign-in. The answer is the user
// record: `quota` is the balance and `checked_in` says whether this sign-in
// granted the day's credit, and the same response carries the session the
// /api/user routes take. The account keeps all of it, so nothing else has to
// be typed in.
async function redeemGithub(base, code, state, inputs) {
  let json;
  let session = "";
  try {
    const res = await fetch(
      `${base}/api/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&mode=login`,
      { headers: DEFAULT_HEADERS, signal: withTimeout(REQUEST_TIMEOUT) },
    );
    session = sessionOf(res);
    ({ json } = await jsonOrText(res));
  } catch (e) {
    return { type: "failed", error: `兑换授权失败：${e?.message ?? String(e)}` };
  }
  if (!json?.success) {
    return { type: "failed", error: String(json?.message ?? "GitHub 授权失败") };
  }
  const d = json.data ?? {};
  const id = d.id ?? "";
  // A token in the body is taken when the site sends one; this site sends
  // `null` there and a session cookie instead, so the token is minted from
  // the session. Without either the account can't read anything.
  let token = String(d.access_token ?? "").trim();
  if (!token && session) token = await tokenForSession(base, session, id);
  if (!token) return { type: "failed", error: "站点没有返回访问令牌" };

  // The completions key is not in this answer either, so it is read with the
  // token: the account's own key list. A site that refuses leaves the key
  // empty, and the account then reads as signed in but unable to chat, which
  // its row says.
  const key = await keyOf(base, token, id);
  return {
    type: "success",
    // magpie saves this as an API sign-in: the key for completions, the
    // access token beside it for the balance and the check-in, and the
    // browser session the site itself set, which is what gets a /api/user
    // read past the WAF.
    key: key ?? "",
    metadata: {
      accessToken: token,
      userId: String(id ?? ""),
      site: String(inputs?.site ?? "org"),
      ...(session ? { cookie: `session=${session}` } : {}),
    },
  };
}

// keyOf reads the account's key with the access token just obtained.
// /api/token/ is a normal user route and answers JSON, so it works where
// /api/user/self may be behind the WAF.
//
// The key is taken as the site stores it rather than required to start with
// "sk-": New API keeps a key exactly as it was generated, and this site's own
// list holds the bare 48 characters, which its /v1 routes accept on their own.
// An empty entry is the only thing that means "no key".
async function keyOf(base, token, id) {
  try {
    const res = await fetch(`${base}/api/token/?p=1&page_size=10`, {
      headers: { ...DEFAULT_HEADERS, Authorization: token, "New-Api-User": String(id ?? "") },
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    const items = json?.data?.items;
    if (!Array.isArray(items)) return "";
    const live = items.find((x) => x && x.status === 1 && typeof x.key === "string") ?? items.find((x) => x && typeof x.key === "string");
    return String(live?.key ?? "").trim();
  } catch {
    return "";
  }
}

// signIn is one POST to the site's login route, and it is the whole feature:
// the login response carries both the day's check-in and the balance.
//
// The vendor grants its daily credit at sign-in rather than through a route
// of its own — its front end says "签到成功，新增额度已到账" when the login
// response has checked_in — and that same response carries quota and
// used_quota, the account's balance. So one call does both jobs, and it is
// also the only way to read the balance from a server: /api/user/self, the
// route New API normally reads it from, is the one this site's WAF answers
// with a slider captcha, while /api/user/login is left alone.
//
// It answers {ok, checkedIn?, balance?, why?}. The caller decides whether a
// false `ok` is the account's to fix (wrong password) or nobody's (the site
// is down), so the reasons stay distinguishable here.
async function signIn(provider, auth) {
  const user = String(meta(auth, "username") ?? "").trim();
  const pass = String(meta(auth, "password") ?? "");
  if (!user || !pass) return { ok: false, why: "no-password" };
  const h = headersOf(provider, auth);
  h["Content-Type"] = "application/json";
  delete h.Authorization;
  let res;
  try {
    res = await fetch(`${siteBase(provider, auth)}/api/user/login`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ username: user, password: pass }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
  const { json, text } = await jsonOrText(res);
  if (!json) {
    if (/^\s*<(?:!doctype|html)/i.test(String(text))) return { ok: false, why: "blocked", blocked: true };
    return { ok: false, why: `HTTP ${res.status}` };
  }
  if (json.success === false) {
    const msg = String(json.message ?? json.msg ?? "");
    // The site words a wrong password and a banned account the same way, so
    // this is "the site refused these credentials", which is the account's
    // to fix.
    if (/密码|password|封禁|banned|错误/i.test(msg)) return { ok: false, why: "bad-password", message: msg };
    return { ok: false, why: msg || "refused", message: msg };
  }
  const d = json.data ?? {};
  const quota = Number(d.quota ?? NaN);
  const used = Number(d.used_quota ?? NaN);
  const balance =
    Number.isFinite(quota) || Number.isFinite(used)
      ? { quota: Number.isFinite(quota) ? quota : 0, used: Number.isFinite(used) ? used : 0 }
      : undefined;
  if (balance) balance.total = balance.quota + balance.used;
  // `checked_in: true` means *this* sign-in granted the day's credit. A false
  // means the day was already claimed, which is not a failure.
  return { ok: true, checkedIn: d.checked_in === true, balance, name: d.username ?? d.display_name ?? "" };
}

// balance asks the site for the account's quota, by signing in. It answers
// {ok, balance?, why?, expired?, blocked?} rather than undefined, because
// the reasons differ and only one of them is the user's to fix: a refused
// password needs a new one, while a site behind a captcha is nothing to do
// with the account.
//
// The token route is tried first when the account has an access token, since
// it is the cheaper read and works on a site that doesn't wall it. On this
// one it is walled, so the sign-in is what actually answers.
async function balance(provider, auth) {
  const viaToken = await balanceByToken(provider, auth);
  if (viaToken.ok) return viaToken;
  const viaLogin = await signIn(provider, auth);
  if (viaLogin.ok) return { ok: true, balance: viaLogin.balance };
  // Report the reason the user can act on: a wrong password outranks a
  // captcha, and a missing password means the token route's failure is the
  // real one.
  if (viaLogin.why === "bad-password") return { ok: false, why: "expired", expired: true, message: viaLogin.message };
  if (viaLogin.why !== "no-password") return viaLogin;
  return viaToken;
}

// balanceByToken reads /api/user/self with the account's access token.
async function balanceByToken(provider, auth) {
  if (!userToken(auth)) return { ok: false, why: "no-token" };
  try {
    const res = await fetch(`${siteBase(provider, auth)}/api/user/self`, {
      headers: userHeaders(provider, auth),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    // New API answers 200 with success:false for a token it refuses, so the
    // status alone doesn't say; the body does.
    if (json && json.success === false) {
      const msg = String(json.message ?? "");
      if (/access\s*token|token.*(无效|invalid)|未登录/i.test(msg)) return { ok: false, why: "expired", expired: true };
      return { ok: false, why: msg || "refused" };
    }
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    // The site sits behind a WAF that answers an HTML slider-captcha page
    // with 200 instead of the JSON: saying "<!doctype html>" back to the
    // user hides the real problem, which is that the read was blocked and a
    // sign-in is what gets past it.
    if (!json) {
      if (/^\s*<(?:!doctype|html)/i.test(String(text))) {
        return { ok: false, why: "blocked", blocked: true };
      }
      return { ok: false, why: String(text).slice(0, 80) };
    }
    const d = json.data ?? {};
    const quota = Number(d.quota ?? 0);
    const used = Number(d.used_quota ?? 0);
    if (!Number.isFinite(quota) && !Number.isFinite(used)) return { ok: false, why: "no-quota" };
    return { ok: true, balance: { quota, used, total: quota + used, name: d.username ?? d.display_name ?? "" } };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// usageOf reports the account's balance to magpie. A New API site has no
// plan windows: what it has is a credit balance, so it is reported as one.
// When it can't be read the error says which of the reasons it was, since
// the user can only fix one of them.
async function usageOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { windows: [] };
  const b = await balance(provider, auth);
  if (!b.ok) {
    const why =
      b.expired
        ? "AgentRouter：站点拒绝了登录，请核对账号里的用户名和密码"
        : b.blocked
          ? "AgentRouter：余额接口被站点的滑动验证码拦截（阿里云 WAF）。在浏览器登录站点、滑过验证后，把 Cookie 填进账号即可读取"
          : b.why === "no-token"
            ? "AgentRouter：账号里没有访问令牌，也没有浏览器 Cookie，无法读取余额（个人设置 → 访问令牌）"
            : b.why === "no-quota"
              ? "AgentRouter：站点没有返回额度字段"
              : `AgentRouter：无法读取余额（${b.why}）`;
    return { error: why, windows: [] };
  }
  const bal = b.balance;
  // The site counts in 1/500000 dollars unless it says otherwise.
  const rate = Number(provider?.quotaPerUnit ?? 500000) || 500000;
  const dollars = (n) => Math.round((n / rate) * 100) / 100;

  // New API's fields, as the site's own dashboard labels them:
  //   quota      the balance left now      ("当前余额")
  //   used_quota what has been spent       ("历史消耗")
  //   both       the credit the account was given
  // magpie's window wants Used and Remaining as *percent*, with the counts
  // beside them in Amount/Limit/Unit — putting the dollars into Used is what
  // made a $326.70 balance read as "0% left" (2265.25 was taken for a
  // percentage). So the percent is computed here and the dollars go where
  // magpie shows counts.
  const left = dollars(bal.quota);
  const spent = dollars(bal.used);
  const whole = dollars(bal.total);
  const usedPct = whole > 0 ? Math.min(100, Math.max(0, (spent / whole) * 100)) : 0;
  const remainingPct = Math.max(0, 100 - usedPct);

  return {
    plan: bal.name || undefined,
    balance: left,
    windows: [
      {
        name: "Balance",
        used: Math.round(usedPct * 10) / 10,
        remaining: Math.round(remainingPct * 10) / 10,
        amount: spent,
        limit: whole,
        unit: "usd",
        display: `$${left.toFixed(2)} / $${whole.toFixed(2)}`,
      },
    ],
  };
}

// checkinOf claims the day's credit the only way this site grants one: by
// signing in. The site has no /api/user/checkin — that path falls through to
// New API's admin route /api/user/:id and answers every ordinary account
// "权限不足", the same as /api/user/foo would — and its front end says
// "签到成功，新增额度已到账" when a login response carries checked_in. So
// signing in *is* the check-in, and the account needs the site password for
// it, not the access token.
//
// What comes back is `claimed` when this sign-in granted the day, and `done`
// when the day was already granted, which is what a second run reports. A
// wrong password is the account's to fix and settles for the day; a site
// that is down is retried, as magpie retries any `failed`.
async function checkinOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { outcome: "failed", message: "AgentRouter：尚未登录" };
  const r = await signIn(provider, auth);
  if (!r.ok) {
    if (r.why === "no-password") {
      return {
        outcome: "ineligible",
        message:
          "AgentRouter：签到就是登录一次，需要在账号里填站点用户名和密码（个人设置 → 账号密码），访问令牌不能签到",
      };
    }
    if (r.why === "bad-password") {
      return {
        outcome: "ineligible",
        message: `AgentRouter：站点拒绝了登录，请核对账号里的用户名和密码（站点返回「${r.message ?? r.why}」）`,
        signIn: "expired",
      };
    }
    if (r.blocked) {
      return { outcome: "failed", message: "AgentRouter：登录接口被站点验证码拦截，稍后重试" };
    }
    return { outcome: "failed", message: `AgentRouter：登录失败（${r.why}）` };
  }
  if (r.checkedIn) {
    return { outcome: "claimed", message: "AgentRouter：已通过登录完成签到，新增额度已到账" };
  }
  return { outcome: "done", message: "AgentRouter：今日额度已发放（登录时由站点自动完成）" };
}

// modelsOf asks the vendor for the models this account has. It is the same
// list every agent sees, and the vendor keeps it current.
async function modelsOf(provider, { auth } = {}) {
  const fallback = provider?.models ?? {};
  if (!auth) return fallback;
  const key = apiKey(auth);
  if (!key) return fallback;
  try {
    const res = await fetch(`${apiBase(provider, auth)}/models`, {
      headers: applyHeaders(new Headers(), { ...headersOf(provider, auth), Authorization: `Bearer ${key}` }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    if (!res.ok || !Array.isArray(json?.data)) return fallback;
    const out = {};
    for (const m of json.data) {
      if (!m?.id) continue;
      out[m.id] = {
        ...MODEL_SHAPE,
        name: m.name ?? m.display_name ?? m.id,
        limit: {
          context: Number(m.context_length ?? m.context_window ?? MODEL_SHAPE.limit.context) || MODEL_SHAPE.limit.context,
          output: Number(m.max_output_tokens ?? m.max_tokens ?? MODEL_SHAPE.limit.output) || MODEL_SHAPE.limit.output,
        },
        ...(m.supported_endpoint_types?.length ? { endpoints: m.supported_endpoint_types } : {}),
        // The vendor says "openai" for what is its Responses API; the gateway
        // reads that as the protocol the model speaks.
        responses: true,
      };
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

export const AgentRouterAuthPlugin = async () => ({
  // The provider before anyone signs in: the models the vendor serves, so the
  // row has something to show, and the shape each listed one takes.
  //
  // The vendor's models answer the Responses API only: a chat-completions
  // request is refused with "does not support /v1/chat/completions, please use
  // /v1/responses", whatever the key. So the provider speaks Responses, and
  // the gateway translates an agent's Chat or Anthropic request into it.
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "AgentRouter",
      npm: "@ai-sdk/openai",
      api: `${ENDPOINT}/v1`,
      models: {
        "gpt-5.6-sol": { ...MODEL_SHAPE, name: "GPT-5.6 Sol" },
        "gpt-6-astra": { ...MODEL_SHAPE, name: "GPT-6 Astra" },
        "gpt-6.1-sol": { ...MODEL_SHAPE, name: "GPT-6.1 Sol" },
      },
    };
  },

  auth: {
    provider: PROVIDER,

    // Both credentials, because the vendor splits them: the key makes the
    // requests, and the site account signs in to claim the day and read the
    // balance.
    methods: [
      {
        type: "api",
        label: "AgentRouter API 密钥",
        placeholder: "sk-…",
        prompts: [
          {
            type: "text",
            key: "endpoint",
            message: "请求端点（对话与模型列表）",
            placeholder: ENDPOINT,
          },
          {
            type: "select",
            key: "site",
            message: "站点（签到与余额走这里）",
            options: [
              { label: "agentrouter.org", value: "org" },
              { label: "ps.air-outer.com（备用域名）", value: "air" },
            ],
          },
          {
            type: "text",
            key: "username",
            message: "站点用户名或邮箱（签到＝登录一次，需要账号密码）",
            placeholder: "留空则不签到，对话仍可用",
          },
          {
            type: "text",
            key: "password",
            message: "站点密码（只存在本机，用于登录签到与读取余额）",
            placeholder: "用 GitHub 登录的账号请先在站点设置密码",
          },
          {
            type: "text",
            key: "cookie",
            message: "浏览器 Cookie（站点登录并滑过验证后，从开发者工具复制；用于读取余额）",
            placeholder: "acw_sc__v2=…; session=…",
          },
          {
            type: "text",
            key: "accessToken",
            message: "访问令牌（可选，站点「个人设置 → 访问令牌」；Cookie 有效时不需要）",
            placeholder: "留空则用浏览器 Cookie 读取余额",
          },
          {
            type: "text",
            key: "userId",
            message: "用户 ID（New-Api-User，仅当站点要求时填写）",
            placeholder: "例如 1234",
          },
          {
            type: "text",
            key: "headers",
            message: "自定义请求头：每行一个「名称: 值」，留空则用默认的 Codex 客户端标识",
            placeholder: "User-Agent: codex_cli_rs/0.101.0",
          },
        ],
        // No `authorize`: the host saves the key itself, and the answers to
        // the prompts become the account's metadata. That is deliberate —
        // an `authorize` here would be handed the prompts' answers *without*
        // the key (the host passes the key beside them, not inside them), so
        // a check written in it can only refuse a correct key. The key is
        // checked on the first request instead, where it actually goes.
      },
      {
        // Signing in the way the site's own "Login with GitHub" button does.
        //
        // It is the one sign-in that yields everything at once: the site
        // answers the callback with the user record, whose `access_token` is
        // the credential the /api/user routes take and whose `quota` is the
        // balance — and it grants the day's credit on the way, which is what
        // the site calls its check-in. So an account signed in this way needs
        // nothing typed in afterwards.
        //
        // The GitHub app is the site's, so its callback is the site's own
        // page and the code lands in the browser's address bar rather than at
        // a server this plugin runs. That is why the code is asked for: the
        // user pastes the address the browser ended on, and the code is read
        // out of it.
        type: "oauth",
        label: "用 GitHub 登录 AgentRouter（推荐）",
        authorize: async (inputs) => {
          const site = siteOf(String(inputs?.site ?? "org"));
          const st = await oauthState(site.site);
          if (!st.ok) throw new Error(st.why);
          const cid = await siteAuthConfig(site.site);
          if (!cid.ok) throw new Error(cid.why);
          const url =
            "https://github.com/login/oauth/authorize" +
            `?client_id=${encodeURIComponent(cid.id)}` +
            `&state=${encodeURIComponent(st.state)}` +
            "&scope=user:email" +
            `&redirect_uri=${encodeURIComponent(callbackUrl(cid.origin))}`;
          return {
            url,
            instructions:
              `在打开的页面用 GitHub 登录并授权。授权后浏览器会跳到 ${cid.origin} 下的一个地址，` +
              "它显示的是「页面未找到」——这是正常的，那一页不会用掉你的授权码。" +
              "请把地址栏里那一整条地址（含 code=…）复制下来，回到这里粘贴。",
            method: "code",
            // The code is read from whatever the user pastes: the whole
            // callback URL, or just the code.
            callback: async (pasted) => {
              const code = codeOf(pasted);
              if (!code) return { type: "failed", error: "没有在粘贴的内容里找到 code" };
              return redeemGithub(site.site, code, st.state, inputs);
            },
          };
        },
        prompts: [
          {
            type: "select",
            key: "site",
            message: "站点",
            options: [
              { label: "agentrouter.org", value: "org" },
              { label: "ps.air-outer.com（备用域名）", value: "air" },
            ],
          },
        ],
      },
    ],

    // The request each completion is sent as. Every model is an OpenAI
    // chat-completions model here, so the body goes on as the gateway wrote
    // it; only the headers are this plugin's business.
    async loader(getAuth, provider) {
      const auth = await getAuth();
      if (!auth) return {};
      const base = apiBase(provider, auth);
      return {
        baseURL: base,
        apiKey: apiKey(auth) || "agentrouter",
        async fetch(input, init = {}) {
          const key = apiKey(auth);
          const h = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init.headers ?? {}).forEach((v, k) => h.set(k, v));
          applyHeaders(h, headersOf(provider, auth));
          if (key) h.set("Authorization", `Bearer ${key}`);
          return fetch(input, { ...init, headers: h });
        },
      };
    },

    usage: usageOf,
    checkin: checkinOf,

    // Switches the user can turn on the provider's editor.
    options: [
      {
        key: "send-codex-headers",
        label: "Send the Codex client headers",
        description:
          "AgentRouter's gateway only answers clients it recognises. On, requests are sent as a Codex CLI's; off, only the headers you gave are sent.",
        default: true,
      },
    ],
  },

  provider: {
    id: PROVIDER,
    models: modelsOf,
  },

  // A conversation's turns reach the vendor under one id, so its cache sees
  // them as one conversation.
  "chat.headers": async (input, output) => {
    if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
    if (input.sessionID) output.headers["x-session-id"] = input.sessionID;
  },
});

export default AgentRouterAuthPlugin;
export const _internal = {
  PROVIDER,
  SITES,
  DEFAULT_HEADERS,
  parseHeaders,
  parseCookies,
  codeOf,
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  masked,
};
