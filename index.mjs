// AgentRouter (agentrouter.org) for magpie / OpenCode.
//
// Three things make this vendor different from a plain OpenAI-compatible
// relay:
//
// 1. Its gateway only answers a client it recognises. A request whose
//    User-Agent is curl's, or a browser's, or anything else off its list is
//    refused with "unauthorized client detected", even when the key is good.
//    So the request headers are not cosmetic here: they are what gets the key
//    through, and the one that works is the vendor's own client's. They are
//    configurable — per provider and per account — and the default is that
//    client's. The provider's own switch turns that default off, for a user
//    who would rather send exactly the headers they named.
//
// 2. It has no daily check-in to call. The site is a New API deployment,
//    and most New API sites put one on GET /api/user/checkin. This one
//    does not: that path falls through to New API's *admin* route
//    /api/user/:id, which answers "权限不足" to every ordinary account —
//    the same answer it gives /api/user/foo or /api/user/zzz. The daily
//    credit is granted at sign-in instead (the site's login response
//    carries checked_in, and its settings keep DailyCheckinQuota), so
//    there is nothing for a plugin to claim after the fact. The check-in
//    hook signs in with the site's username and password when supplied.
//
// 3. /api/user/self reports quota and used_quota, but often returns an
//    Aliyun slider-captcha page instead. Try it with an access token or
//    browser session; neither credential guarantees passage through WAF.
//    A password sign-in can also return the current user record and grant
//    the day's credit. GitHub accounts may have no site password.
//
//    Without a password, what is left is the spend: /api/log/self/stat
//    answers a session or an access token with the account's used quota,
//    and /v1/dashboard/billing/usage answers the key with the same figure
//    in cents. Neither carries the credit, so those accounts report what
//    they spent rather than a balance — an invented one would be worse.
//
// Signing in with only the key is allowed. It can read consumption, but
// cannot determine remaining credit or perform password check-in.

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

// The models this plugin itself ships, by the name to show them under. They
// are what the row lists before the vendor's own list arrives — and what it
// falls back to when that list cannot be read.
//
// magpie also keeps a models.dev catalog, and its cached entry for this
// vendor still carries models the site has retired (see README, "模型列表从
// 哪来"). Falling back to the row's current models would re-advertise them,
// so the fallback is built from this table instead: a model shown here is one
// this plugin vouches for.
const DECLARED_MODELS = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

// codexHeaders is whether requests are sent as a Codex CLI's, as the
// provider's own switch has it. The switch is the vendor's whitelist made
// optional: off, only the headers the user gave are sent. It is read from the
// host when the plugin loads (magpie hands the reader over as input.magpie),
// and defaults to on — including on a host too old to have the switch, which
// is why the option is checked for rather than assumed.
let codexHeaders = () => true;

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
//
// The Codex User-Agent is the switch's business; Accept is not a client
// claim, so it stays whatever the switch says.
function headersOf(provider, auth) {
  return {
    ...(codexHeaders() ? { "User-Agent": DEFAULT_HEADERS["User-Agent"] } : {}),
    Accept: DEFAULT_HEADERS.Accept,
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

// isURLish says whether a value can be a base URL at all: an http(s) address.
// The endpoint question is free text, so a key pasted into it — which is what
// the account manager's first question invites, since it is where the key
// used to go — lands in the same field as a real address does. Such a value
// is not an endpoint however it was stored, and building a base out of it
// sends every request to nothing at all, with no error to show for it.
function isURLish(v) {
  return /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
}

// apiBase is the base completions go to. It follows the account's own
// endpoint when it gave one, and otherwise the endpoint this plugin was built
// for — never the check-in site, so picking ps.air-outer.com for the check-in
// doesn't quietly move requests off agentrouter.org.
//
// A stored endpoint that isn't a URL is ignored rather than used: the
// request then still goes to the vendor, which is what the account wanted
// when it pasted a key there.
function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (isURLish(said)) return `${said.replace(/\/+$/, "")}/v1`;
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
// A valid session authenticates user reads. WAF can still challenge those
// reads even when the same Cookie works in a browser.
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

// redeemGithub trades the code for the site's sign-in. The answer is the user
// record: `quota` is the balance and `checked_in` says whether this sign-in
// granted the day's credit, and the same response carries the session the
// /api/user routes take. The account keeps this session alongside the
// system access token explicitly entered before authorization.
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
  // Keep the explicitly entered system token; regenerating it here would
  // invalidate the token the user just supplied.
  const token = String(inputs?.accessToken ?? "").trim();
  if (!token) return { type: "failed", error: "请填写系统访问令牌（AgentRouter 个人设置 → 访问令牌）" };

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
  const quota = quotaNumber(d.quota);
  const used = quotaNumber(d.used_quota);
  const balance =
    Number.isFinite(quota) && Number.isFinite(used)
      ? { quota, used, name: d.username ?? d.display_name ?? "" }
      : undefined;
  if (balance) balance.total = balance.quota + balance.used;
  // `checked_in: true` means *this* sign-in granted the day's credit. A false
  // means the day was already claimed, which is not a failure.
  return { ok: true, checkedIn: d.checked_in === true, balance, name: d.username ?? d.display_name ?? "" };
}

// Try the read-only user endpoint first, then password sign-in. Preserve
// the failure reason when neither returns a complete quota record.
async function balance(provider, auth) {
  const viaToken = await balanceByToken(provider, auth);
  if (viaToken.ok) return viaToken;
  const viaLogin = await signIn(provider, auth);
  if (viaLogin.ok && viaLogin.balance) return { ok: true, balance: viaLogin.balance };
  if (viaLogin.ok) return { ok: false, why: "no-quota" };
  // Report the reason the user can act on: a wrong password outranks a
  // captcha, and a missing password means the token route's failure is the
  // real one.
  if (viaLogin.why === "bad-password") return { ok: false, why: "expired", expired: true, message: viaLogin.message };
  if (viaLogin.why !== "no-password") return viaLogin;
  return viaToken;
}

// Read /api/user/self with either an access token or a browser session.
async function balanceByToken(provider, auth) {
  if (!userToken(auth) && !parseCookies(cookieText(auth))) return { ok: false, why: "no-token" };
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
    const quota = quotaNumber(d.quota);
    const used = quotaNumber(d.used_quota);
    if (!Number.isFinite(quota) || !Number.isFinite(used)) return { ok: false, why: "no-quota" };
    return { ok: true, balance: { quota, used, total: quota + used, name: d.username ?? d.display_name ?? "" } };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// These endpoints report cumulative consumption, never remaining credit.
async function spendOf(provider, auth) {
  const rate = quotaRate(provider);
  const reads = [];
  if (userToken(auth) || parseCookies(cookieText(auth))) {
    reads.push({
      url: `${siteBase(provider, auth)}/api/log/self/stat`,
      headers: userHeaders(provider, auth),
      field: "quota",
      divisor: rate,
    });
  }
  if (apiKey(auth)) {
    reads.push({
      url: `${apiBase(provider, auth)}/dashboard/billing/usage`,
      headers: { ...headersOf(provider, auth), Authorization: `Bearer ${apiKey(auth)}` },
      field: "total_usage",
      divisor: 100,
    });
  }
  for (const read of reads) {
    try {
      const res = await fetch(read.url, { headers: read.headers, signal: withTimeout(REQUEST_TIMEOUT) });
      const { json } = await jsonOrText(res);
      if (!res.ok || !json || json.success === false) continue;
      const value = (json.data ?? json)[read.field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      return { ok: true, spent: value / read.divisor };
    } catch {
      // A failed user read must not prevent the independent key fallback.
    }
  }
  return { ok: false };
}

function quotaNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function quotaRate(provider) {
  const rate = Number(provider?.quotaPerUnit ?? 500000);
  return Number.isFinite(rate) && rate > 0 ? rate : 500000;
}

// magpie cannot show a percent-free consumption window. Use its text status
// for partial data so spend never becomes a balance or an invented 0% window.
async function usageOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { windows: [] };
  const b = await balance(provider, auth);
  if (!b.ok) {
    const spend = await spendOf(provider, auth);
    if (spend.ok) {
      const reason = b.blocked
        ? "余额接口被滑动验证码拦截"
        : b.expired ? "站点拒绝了余额查询凭据，请核对用户名密码或访问令牌" : "余额接口未返回可用余额";
      return {
        error: `AgentRouter：累计消耗 $${spend.spent.toFixed(2)}；剩余额度未知（${reason}）。读取余额需有效的 Cookie/访问令牌和用户 ID，或站点用户名密码；Cookie 不能保证通过验证码`,
        windows: [],
      };
    }
    const why =
      b.expired
        ? "AgentRouter：站点拒绝了凭据，请核对用户名密码、访问令牌或 Cookie 及用户 ID"
        : b.blocked
          ? "AgentRouter：余额接口被滑动验证码拦截，剩余额度未知。Cookie 不能保证通过验证码；可尝试有效的站点用户名密码读取余额"
          : b.why === "no-token"
            ? "AgentRouter：账号里没有访问令牌，也没有浏览器 Cookie，无法读取余额（个人设置 → 访问令牌）"
            : b.why === "no-quota"
              ? "AgentRouter：站点没有返回额度字段"
              : `AgentRouter：无法读取余额（${b.why}）`;
    return { error: why, windows: [] };
  }
  const bal = b.balance;
  // The site counts in 1/500000 dollars unless it says otherwise.
  const rate = quotaRate(provider);
  const dollars = (n) => Math.round((n / rate) * 100) / 100;

  // New API's fields, as the site's own dashboard labels them:
  //   quota      the balance left now      ("当前余额")
  //   used_quota what has been spent       ("历史消耗")
  //   both       the credit the account was given
  // magpie's window wants Used and Remaining as *percent*, with the counts
  // beside them in Amount/Limit/Unit — putting the dollars into Used is what
  // can make a positive balance read as "0% left" when a dollar count is
  // taken for a percentage. The percent is computed here; dollars go where
  // magpie shows counts.
  const left = dollars(bal.quota);
  const spent = dollars(bal.used);
  const whole = dollars(bal.total);
  const usedPct = whole > 0 ? Math.min(100, Math.max(0, (spent / whole) * 100)) : 0;
  const remainingPct = Math.max(0, 100 - usedPct);

  return {
    plan: bal.name || undefined,
    balance: `$${left.toFixed(2)}`,
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

// declaredModels is the models this plugin vouches for, in the shape magpie
// wants: a fresh object each time, because magpie edits what it is given.
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
}

// ---- what the vendor refuses -----------------------------------------------

// The vendor runs its own content filter in front of the models. It refuses
// text it doesn't like with HTTP 400 and `code: "content-blocked"` — no
// rate-limit headers, nothing about the key, and no hint that the *text* is
// what it objected to.
//
// Two things make this worth a word of our own. An agent that reads a bare
// 400 as a transient gateway fault retries the identical text, and waits, and
// retries again: the text never becomes acceptable, so the loop never ends.
// And the shape is indistinguishable from a rate limit at a glance, which is
// exactly how it gets reported ("AgentRouter 429 限流").
//
// So a refusal is rewritten to say what it is, keeping the vendor's own code
// and request id (both are what support asks for) and adding what to do
// instead. Every other status is handed back untouched: a real 429, a 401, a
// 5xx are the caller's business, and guessing at them would be worse than
// saying nothing.
//
// What trips the filter is not size — a 200k-token request of ordinary prose
// goes through — but particular words and self-referential phrasing. That is
// the vendor's list to keep, so it is not repeated here; the advice is to
// rephrase, not to guess at a blocklist.
//
// The wording below is deliberately free of quota and rate-limit words
// ("limit", "quota", "额度", "限流", …). magpie decides whether a failed request
// may be retried elsewhere by matching those words in the body
// (internal/gateway/fallback.go's retryable/quotaWords). A refusal that reads
// like a rate limit is therefore retried on every account and then fails over
// to another provider — which is how a refused message ends up surfacing as
// somebody else's 429. Naming the refusal as a refusal is what stops that.
const CONTENT_BLOCKED = /"code"\s*:\s*"content-blocked"/i;

function refusalNote(id) {
  const said = id ? ` (request id: ${id})` : "";
  return (
    "AgentRouter 的内容过滤器拒绝了这段请求内容" +
    said +
    "：被拒的是文字本身，不是账号、密钥或服务状态，所以等待和重发同一段内容都不会通过。" +
    "请改写被拒的部分（某些词、自指句式常被拒），或改用其他服务商。"
  );
}

// explainRefusal passes a reply through unless the vendor refused the text, in
// which case the body is replaced with one that says so. It never changes a
// status code: a 400 stays a 400, so nothing upstream starts retrying on a
// refusal it would only get again.
async function explainRefusal(res) {
  if (!res || res.status !== 400) return res;
  let text;
  try {
    text = await res.clone().text();
  } catch {
    return res;
  }
  if (!CONTENT_BLOCKED.test(text)) return res;

  let code = "content-blocked";
  let id = "";
  let message = "";
  try {
    const j = JSON.parse(text);
    const e = j?.error && typeof j.error === "object" ? j.error : j;
    code = String(e?.code ?? code);
    message = String(e?.message ?? "");
    const m = /request id:\s*([A-Za-z0-9]+)/.exec(message);
    if (m) id = m[1];
  } catch {
    // A body that isn't JSON still says content-blocked; that is enough.
  }
  const body = JSON.stringify({
    error: {
      code,
      message: refusalNote(id),
      type: "agent_router_content_blocked",
      // the vendor's own words, so a support ticket can quote them
      upstream: message,
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: { "content-type": "application/json" },
  });
}

// modelsOf asks the vendor for the models this account has. It is the same
// list every agent sees, and the vendor keeps it current.
async function modelsOf(provider, { auth } = {}) {
  // The fallback is this plugin's own list, never the row's: the row may
  // still carry models a cached models.dev catalog gave it, and handing those
  // back would advertise models the site no longer serves.
  const fallback = declaredModels();
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

export const AgentRouterAuthPlugin = async (input) => {
  // The host hands over its reader for the provider's switches; an older one
  // has none, and the Codex headers stay on there (README, "为什么需要自定义
  // 请求头"). Reading it through a closure keeps headersOf's own signature —
  // provider and account — which every caller already passes.
  codexHeaders = () => input?.magpie?.option?.(PROVIDER, "send-codex-headers") !== false;
  return {
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
        models: declaredModels(),
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
              // The key is asked for separately, last. This question is here
              // because the editor's box is where the key used to go: a key
              // pasted into it becomes apiBase's endpoint and every request
              // then goes nowhere, silently. So the answer is checked here,
              // where the user can still be told.
              validate: (v) =>
                !String(v ?? "").trim() || isURLish(v)
                  ? undefined
                  : "请填站点地址，例如 https://agentrouter.org（不要在这里填 API 密钥）",
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
              message: "浏览器 Cookie（可选，登录站点后复制请求中的 Cookie；需同时填用户 ID，仍可能被验证码拦截）",
              placeholder: "session=…",
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
              message: "用户 ID（New-Api-User；用 Cookie 或访问令牌读取账号数据时填写）",
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
          // Ask for the site's system access token before authorization.
          // GitHub supplies the user ID and session; the entered token is kept
          // for account reads and is never regenerated by this flow.
          //
          // The GitHub app is the site's, so its callback is the site's own
          // page and the code lands in the browser's address bar rather than at
          // a server this plugin runs. That is why the code is asked for: the
          // user pastes the address the browser ended on, and the code is read
          // out of it.
          type: "oauth",
          label: "用 GitHub 登录 AgentRouter（推荐）",
          authorize: async (inputs) => {
            if (!String(inputs?.accessToken ?? "").trim()) {
              throw new Error("请填写系统访问令牌（AgentRouter 个人设置 → 访问令牌，不是 API 密钥或 GitHub Token）");
            }
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
              type: "text",
              key: "accessToken",
              message: "系统访问令牌（必填，AgentRouter「个人设置 → 访问令牌」；不是 API 密钥或 GitHub Token）",
              placeholder: "粘贴系统访问令牌，用于查询账号额度",
            },
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
      // it; only the headers are this plugin's business — and, when the vendor
      // refuses the text itself, the reason it is refused.
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
            return explainRefusal(await fetch(input, { ...init, headers: h }));
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
  };
};

export default AgentRouterAuthPlugin;
export const _internal = {
  PROVIDER,
  SITES,
  DEFAULT_HEADERS,
  DECLARED_MODELS,
  parseHeaders,
  parseCookies,
  codeOf,
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  masked,
  isURLish,
  declaredModels,
};
