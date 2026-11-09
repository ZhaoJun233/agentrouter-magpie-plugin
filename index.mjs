import { explainResponse } from "./response.mjs";
import { prepareRequest } from "./request.mjs";
import { loadTextFilter } from "./content-filter.mjs";
import { parseGithubCookie } from "./github-cookie.mjs";

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
//    hook can renew GitHub OAuth using an explicitly supplied GitHub session.
//    Legacy password login remains available only for sites supporting it.
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
// cannot determine remaining credit or renew a GitHub login for check-in.

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
//
// LinuxDo has the same SPA behaviour: /oauth/linuxdo is a route that redeems
// the code on load, then navigates away, so the address bar no longer carries
// code/state for manual copy. The sub-path /oauth/linuxdo/magpie avoids that
// route the same way GitHub's sub-path does.
const GITHUB_CALLBACK_PATH = "/oauth/github/magpie";
const LINUXDO_CALLBACK_PATH = "/oauth/linuxdo/magpie";
const LINUXDO_AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize";

// Login accepts only a full callback URL belonging to this flow.
function githubCallbackCode(pasted, expectedURL, state) {
  const text = String(pasted ?? "").trim();
  if (!text || text.length > 8192) return "";
  try {
    const url = new URL(text);
    const expected = new URL(expectedURL);
    const params = url.searchParams;
    if (url.origin !== expected.origin || url.pathname !== expected.pathname ||
        url.username || url.password || url.hash || params.has("error") ||
        params.getAll("state").length !== 1 || params.get("state") !== state ||
        params.getAll("code").length !== 1) return "";
    const code = params.get("code");
    return /^[A-Za-z0-9_-]{8,2048}$/.test(code ?? "") ? code : "";
  } catch {
    return "";
  }
}

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
    const st = typeof json?.data === "string" ? json.data.trim() : "";
    if (!res.ok || json?.success !== true || !st) return { ok: false, why: "站点没有下发 OAuth state" };
    const stateCookie = sessionOf(res);
    return { ok: true, state: st, stateCookie };
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
    const id = typeof json?.data?.github_client_id === "string" ? json.data.github_client_id.trim() : "";
    const linuxdoId = typeof json?.data?.linuxdo_client_id === "string" ? json.data.linuxdo_client_id.trim() : "";
    if (!res.ok || (!id && !linuxdoId)) return { ok: false, why: "站点没有开启 GitHub 或 LinuxDo 登录" };
    const reported = json.data.server_address;
    if (reported != null && typeof reported !== "string") return { ok: false, why: "站点回调地址无效" };
    const url = new URL(String(reported ?? "").trim() || base);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        !Object.values(SITES).some(site => site.site === url.origin)) {
      return { ok: false, why: "站点回调地址不受信任" };
    }
    return { ok: true, id, linuxdoId, origin: url.origin };
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
  const token = String(inputs.accessToken ?? "").trim();
  const provider = inputs.provider === "linuxdo" ? "linuxdo" : "github";
  const label = provider === "linuxdo" ? "LinuxDo" : "GitHub";
  if (!token) return { type: "failed", error: "缺少系统访问令牌，请重新登录或改用 API Key 接入。" };
  const headers = { ...DEFAULT_HEADERS };
  if (inputs.stateCookie) headers.Cookie = "session=" + inputs.stateCookie;
  const u = new URL(base + "/api/oauth/" + provider);
  u.searchParams.set("code", code);
  u.searchParams.set("state", state);
  u.searchParams.set("mode", "login");
  const res = await fetch(u, { headers, redirect: "manual", signal: withTimeout(REQUEST_TIMEOUT) });
  const session = sessionOf(res);
  const { json } = await jsonOrText(res);
  const d = json?.data;
  if (!res.ok || json?.success !== true || !d?.id) {
    return { type: "failed", error: `${label} 授权兑换未完成，授权码可能已使用或过期；请重新授权或改用 API Key 接入。` };
  }
  const found = await keyOf(base, token, String(d.id));
  if (found.kind !== "found") {
    const messages = {
      missing: "未找到启用且完整的模型 Key",
      ambiguous: "存在多个不同的模型 Key，无法确定使用哪一个",
      incomplete: "模型 Key 列表可能不完整，无法确定唯一候选",
      rejected: "站点拒绝读取模型 Key，请检查系统访问令牌及权限",
      blocked: "读取模型 Key 时遇到站点验证页",
      unsupported: "站点返回的模型 Key 列表格式无法确认",
      upstream: "站点暂时无法提供模型 Key 列表",
      network: "读取模型 Key 的网络请求失败或超时",
    };
    return { type: "failed", error: messages[found.kind] + "。请改用 API Key 接入，或确认后主动重试。" };
  }
  return {
    type: "success",
    key: found.key,
    metadata: {
      site: base === SITES.air.site ? "air" : "org",
      provider,
      ...(base === SITES.air.site ? { apiBase: `${SITES.air.api}/v1` } : {}),
      accessToken: token,
      userId: String(d.id),
      ...(session ? { cookie: "session=" + session } : {}),
    },
  };
}

function usableModelKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return key !== "" && !["agentrouter", "your_api_key"].includes(key.toLowerCase()) && !/[*…<>]|\.\.\.|\s/.test(key);
}

function selectModelKey(json, pageSize) {
  const data = json?.data;
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) return { kind: "unsupported" };
  const total = Array.isArray(data) ? json.total : data?.total;
  if (total != null && (!Number.isSafeInteger(total) || total < items.length)) return { kind: "unsupported" };
  if (total != null ? total > items.length : items.length >= pageSize) return { kind: "incomplete" };
  const keys = new Set();
  const now = Date.now() / 1000;
  for (const item of items) {
    if (item?.status !== 1 || !usableModelKey(item.key)) continue;
    const expiry = item.expired_time;
    if (expiry != null && (typeof expiry !== "number" || !Number.isFinite(expiry) || (expiry !== -1 && expiry <= now))) continue;
    keys.add(item.key.trim());
  }
  if (keys.size === 0) return { kind: "missing" };
  if (keys.size !== 1) return { kind: "ambiguous" };
  return { kind: "found", key: keys.values().next().value };
}

async function keyOf(base, token, id) {
  const pageSize = 10;
  try {
    const res = await fetch(base + "/api/token/?p=1&page_size=" + pageSize, {
      headers: { ...DEFAULT_HEADERS, Authorization: token, "New-Api-User": id },
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    if (!json && /^\s*</.test(text)) return { kind: "blocked" };
    if (res.status === 401 || res.status === 403) return { kind: "rejected" };
    if (!res.ok) return { kind: "upstream" };
    if (json?.success === false) return { kind: "rejected" };
    return selectModelKey(json, pageSize);
  } catch {
    return { kind: "network" };
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
  // means no new grant; a missing/non-boolean marker proves nothing.
  return { ok: true, checkedIn: d.checked_in, balance, name: d.username ?? d.display_name ?? "" };
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

// A completed login and a confirmed reward are different results.
function checkinResult(checkedIn) {
  if (checkedIn === true) return { outcome: "claimed", message: "AgentRouter：站点确认本次登录签到成功，新增额度已到账" };
  if (checkedIn === false) return { outcome: "done", message: "AgentRouter：已完成登录，站点返回本次未新增签到额度（checked_in=false）" };
  return { outcome: "failed", message: "AgentRouter：登录成功但站点未返回有效签到标记，无法确认额度发放" };
}

// GitHub's session is NOT the AgentRouter session. Start a fresh OAuth login
// without the old site's identity; otherwise New API may bind instead of login.
// No automatic redirects, form submissions, or forwarding cookies across sites.
async function githubCheckin(provider, auth, cookieText) {
  const expectedId = userId(auth);
  if (!/^[1-9][0-9]*$/.test(expectedId)) {
    return { outcome: "ineligible", message: "AgentRouter：GitHub 自动签到需要本站用户 ID，以校验登录账号" };
  }
  const parsed = parseGithubCookie(cookieText);
  if (parsed.error || !parsed.cookie) {
    return { outcome: "ineligible", message: "AgentRouter：" + (parsed.error || "GitHub 自动签到需要 GitHub 登录 Cookie，可稍后重新配置") };
  }
  const githubCookie = parsed.cookie;
  const manual = { outcome: "ineligible", message: "AgentRouter：GitHub 登录态失效或需要授权/二次验证；请在浏览器完成 GitHub 登录并更新 githubCookie" };
  let stage = "获取站点配置";
  try {
    const base = new URL(siteBase(provider, auth));
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      return { outcome: "ineligible", message: "AgentRouter：自动签到要求可信的 HTTPS 站点根地址" };
    }
    const signal = withTimeout(REQUEST_TIMEOUT);
    const publicHeaders = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };
    const siteJSON = async (path, cookie = "") => {
      const response = await fetch(base.origin + path, {
        headers: { ...publicHeaders, ...(cookie ? { Cookie: cookie } : {}) },
        redirect: "manual", signal,
      });
      if (!response.ok) throw new Error("site-http");
      const payload = await response.json();
      if (payload?.success !== true) throw new Error("site-rejected");
      return { payload, cookie: sessionOf(response) };
    };
    const { payload: config } = await siteJSON("/api/status");
    if (!config.data?.github_oauth || !config.data?.github_client_id) {
      return { outcome: "ineligible", message: "AgentRouter：当前站点未启用 GitHub OAuth" };
    }
    stage = "建立 OAuth 登录状态";
    const { payload: init, cookie: stateCookie } = await siteJSON("/api/oauth/state?mode=login");
    if (typeof init.data !== "string" || !init.data || !stateCookie) throw new Error("no-state");
    const state = init.data;
    let url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({client_id: String(config.data.github_client_id), state, scope: "user:email"}).toString();
    stage = "GitHub 重新授权";
    let callback;
    for (let hops = 0; hops < 5; hops++) {
      const response = await fetch(url.href, {
        headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0", Cookie: githubCookie },
        redirect: "manual", signal,
      });
      if (response.status === 200) return manual;
      if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error("github-http");
      const location = response.headers.get("location");
      if (!location) throw new Error("no-location");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password || next.hash) throw new Error("unsafe-location");
      if (next.origin === base.origin) {
        if (next.pathname !== "/oauth/github" || next.searchParams.get("state") !== state || !next.searchParams.get("code")) {
          throw new Error("invalid-callback");
        }
        callback = next;
        break;
      }
      if (next.origin !== "https://github.com") throw new Error("unexpected-origin");
      if (next.pathname !== "/login/oauth/authorize") return manual;
      if (next.searchParams.get("client_id") !== String(config.data.github_client_id) || next.searchParams.get("state") !== state) {
        throw new Error("changed-oauth-request");
      }
      url = next;
    }
    if (!callback) throw new Error("redirect-limit");
    stage = "兑换 OAuth 登录结果";
    const query = new URLSearchParams({code: callback.searchParams.get("code"), state, mode: "login"});
    const { payload: login } = await siteJSON("/api/oauth/github?" + query, "session=" + stateCookie);
    if (String(login.data?.id ?? "") !== expectedId || login.message === "bind") {
      return { outcome: "ineligible", message: "AgentRouter：GitHub 登录结果与当前账号用户 ID 不符，未将当前账号标记为已签到；请核对每个账号的 githubCookie" };
    }
    return checkinResult(login.data?.checked_in);
  } catch {
    // Exception text can contain cookies or one-time codes; never echo it.
    return { outcome: "failed", message: "AgentRouter：" + stage + "失败（网络、站点响应或验证码异常），未确认签到，稍后重试" };
  }
}

// checkinOf claims the day's credit the only way this site grants one: by
// signing in. The site has no /api/user/checkin — that path falls through to
// New API's admin route /api/user/:id and answers every ordinary account
// "权限不足", the same as /api/user/foo would — and its front end says
// "签到成功，新增额度已到账" when a login response carries checked_in. So
// signing in *is* the check-in. GitHub-only accounts need a GitHub session;
// their site access token or site session cannot repeat the OAuth login.
//
// What comes back is `claimed` when this sign-in granted the day, and `done`
// when the site explicitly reports no new grant (not proof of an earlier one). A
// wrong password is the account's to fix and settles for the day; a site
// that is down is retried, as magpie retries any `failed`.
async function checkinOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { outcome: "failed", message: "AgentRouter：尚未登录" };
  // Explicit skip wins over stale hidden Cookie metadata, including on older hosts.
  const githubCookie = meta(auth, "githubCookieMode") === "skip" ? "" :
    (auth.githubCookie ?? auth.metadata?.githubCookie);
  // Only parser-recognized blanks fall back; malformed saved values must still be rejected.
  if (parseGithubCookie(githubCookie ?? "").cookie !== "") {
    return githubCheckin(provider, auth, githubCookie);
  }
  const r = await signIn(provider, auth);
  if (!r.ok) {
    if (r.why === "no-password") {
      return {
        outcome: "ineligible",
        message:
          "AgentRouter：GitHub 自动签到需要额外配置 githubCookie（GitHub 登录态）；现有站点 Cookie/访问令牌不能重新完成 GitHub 登录",
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
  return checkinResult(r.checkedIn);
}

// declaredModels is the models this plugin vouches for, in the shape magpie
// wants: a fresh object each time, because magpie edits what it is given.
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
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
  const portableResponses = () => input?.magpie?.option?.(PROVIDER, "portable-responses") !== false;
  const textFilterEnabled = () => input?.magpie?.option?.(PROVIDER, "text-filter") !== false;
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
          label: "API Key（推荐）",
          // The current host owns the one native Key input and saves it.
          // Its authorize callback does not receive that Key for validation.
          ...(input?.magpie ? {
            authorize: async (inputs) => {
              const site = siteOf(inputs?.site) === SITES.air ? "air" : "org";
              return {
                type: "success",
                metadata: {
                  site,
                  ...(site === "air" ? { apiBase: `${SITES.air.api}/v1` } : {}),
                },
              };
            },
          } : {}),
          prompts: [
            {
              type: "select",
              key: "site",
              message: "选择站点（国际站 / 国内站）",
              options: [
                { value: "org", label: "国际站 agentrouter.org" },
                { value: "air", label: "国内站 ps.air-outer.com" },
              ],
            },
          ],
        },
        {
          type: "oauth",
          label: "GitHub（需系统访问令牌）",
          authorize: async (inputs) => {
            const token = String(inputs?.accessToken ?? "").trim();
            if (!token) return { type: "failed", error: "请输入系统访问令牌；如已有模型 Key，请改用 API Key 接入。" };
            const selected = siteOf(inputs?.site);
            let state, cfg;
            let stateCookie = "";
            try {
              const st = await oauthState(selected.site);
              if (!st.ok || typeof st.state !== "string" || !st.state.trim()) throw new Error("invalid OAuth state");
              state = st.state;
              stateCookie = st.stateCookie ?? "";
              cfg = await siteAuthConfig(selected.site);
              if (!cfg.ok || !cfg.id) throw new Error("invalid OAuth configuration");
            } catch {
              return { type: "failed", error: "无法获取 GitHub 授权配置，请检查网络或站点验证后重试，也可改用 API Key 接入。" };
            }
            const u = new URL("https://github.com/login/oauth/authorize");
            const redirectUri = callbackUrl(cfg.origin);
            u.searchParams.set("client_id", cfg.id);
            u.searchParams.set("redirect_uri", redirectUri);
            u.searchParams.set("scope", "user:email");
            u.searchParams.set("state", state);
            return {
              url: u.href,
              method: "code",
              instructions: "若未自动打开浏览器，请手动打开链接并完成 GitHub 授权。最终页面可能显示「页面未找到」，请勿刷新；复制地址栏的完整回调地址并粘贴回来，保留 code 和 state。授权码一次有效，失效后请重新登录。插件只查找已有模型 Key；失败时可改用 API Key 接入。请勿将回调地址发到聊天或日志。",
              callback: async (value) => {
                let cb;
                try {
                  if (typeof value !== "string" || !value.trim().startsWith("https://")) throw new Error("full callback required");
                  cb = githubCallbackCode(value, redirectUri, state);
                  if (!cb) throw new Error("invalid callback");
                } catch {
                  return { type: "failed", error: "回调地址无效或 state 不匹配。请重新登录获得新链接，再粘贴完整回调地址。" };
                }
                try {
                  return await redeemGithub(selected.site, cb, state, { accessToken: token, stateCookie });
                } catch {
                  return { type: "failed", error: "GitHub 授权兑换请求失败或超时，请重新授权重试或改用 API Key 接入。" };
                }
              },
            };
          },
          prompts: [
            {
              type: "select",
              key: "site",
              message: "选择站点（国际站 / 国内站）",
              options: [
                { value: "org", label: "国际站 agentrouter.org" },
                { value: "air", label: "国内站 ps.air-outer.com" },
              ],
            },
            {
              type: "password",
              key: "accessToken",
              message: "系统访问令牌（AgentRouter 个人设置 → 访问令牌；不是模型 API Key）",
              validate: value => String(value ?? "").trim() ? undefined : "请输入系统访问令牌；如已有模型 Key，请改用 API Key 入口",
            },
          ],
        },
        {
          type: "oauth",
          label: "LinuxDo（需系统访问令牌）",
          authorize: async (inputs) => {
            const token = String(inputs?.accessToken ?? "").trim();
            if (!token) return { type: "failed", error: "请输入系统访问令牌；如已有模型 Key，请改用 API Key 接入。" };
            const selected = siteOf(inputs?.site);
            let state, cfg;
            let stateCookie = "";
            try {
              const st = await oauthState(selected.site);
              if (!st.ok || typeof st.state !== "string" || !st.state.trim()) throw new Error("invalid OAuth state");
              state = st.state;
              stateCookie = st.stateCookie ?? "";
              cfg = await siteAuthConfig(selected.site);
              if (!cfg.ok || !cfg.linuxdoId) throw new Error("invalid OAuth configuration");
            } catch {
              return { type: "failed", error: "无法获取 LinuxDo 授权配置，请检查网络或站点验证后重试，也可改用 API Key 接入。" };
            }
            const u = new URL(LINUXDO_AUTHORIZE_URL);
            const redirectUri = `${cfg.origin}${LINUXDO_CALLBACK_PATH}`;
            u.searchParams.set("client_id", cfg.linuxdoId);
            u.searchParams.set("redirect_uri", redirectUri);
            u.searchParams.set("response_type", "code");
            u.searchParams.set("scope", "user");
            u.searchParams.set("state", state);
            return {
              url: u.href,
              method: "code",
              instructions: "若未自动打开浏览器，请手动打开链接并完成 LinuxDo 授权。完成后会回到登录成功页，请复制地址栏的完整回调地址并粘贴回来，保留 code 和 state。授权码一次有效，失效后请重新登录。插件只查找已有模型 Key；失败时可改用 API Key 接入。请勿将回调地址发到聊天或日志。",
              callback: async (value) => {
                let cb;
                try {
                  if (typeof value !== "string" || !value.trim().startsWith("https://")) throw new Error("full callback required");
                  cb = githubCallbackCode(value, redirectUri, state);
                  if (!cb) throw new Error("invalid callback");
                } catch {
                  return { type: "failed", error: "回调地址无效或 state 不匹配。请重新登录获得新链接，再粘贴完整回调地址。" };
                }
                try {
                  return await redeemGithub(selected.site, cb, state, { accessToken: token, provider: "linuxdo", stateCookie });
                } catch {
                  return { type: "failed", error: "LinuxDo 授权兑换请求失败或超时，请重新授权重试或改用 API Key 接入。" };
                }
              },
            };
          },
          prompts: [
            {
              type: "select",
              key: "site",
              message: "选择站点（国际站 / 国内站）",
              options: [
                { value: "org", label: "国际站 agentrouter.org" },
                { value: "air", label: "国内站 ps.air-outer.com" },
              ],
            },
            {
              type: "password",
              key: "accessToken",
              message: "系统访问令牌（AgentRouter 个人设置 → 访问令牌；不是模型 API Key）",
              validate: value => String(value ?? "").trim() ? undefined : "请输入系统访问令牌；如已有模型 Key，请改用 API Key 入口",
            },
          ],
        },
      ],

      // Inline replay avoids resource-local item lookups when complete contents
      // are present. Server-only references and unknown kinds stay untouched.
      // Response normalization preserves successful bytes and never retries.
      async loader(getAuth, provider) {
        const auth = (await getAuth()) ?? {};
        const textFilter = textFilterEnabled() ? await loadTextFilter() : null;
        const base = apiBase(provider, auth);
        return {
          baseURL: base,
          apiKey: apiKey(auth) || "agentrouter",
          async fetch(input, init = {}) {
            const key = apiKey(auth);
            if (!usableModelKey(key)) {
              return Response.json({ error: {
                type: "invalid_request_error",
                code: "agentrouter_missing_api_key",
                message: "尚未配置模型 API Key，请使用 API Key 入口补充。系统访问令牌和 GitHub Cookie 不能用于模型调用。",
              } }, { status: 400 });
            }
            const h = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init.headers ?? {}).forEach((v, k) => h.set(k, v));
            applyHeaders(h, headersOf(provider, auth));
            if (key) h.set("Authorization", `Bearer ${key}`);
            const requestInit = { ...init, headers: h };
            const prepared = await prepareRequest(input, requestInit, {
              portableResponses: portableResponses(),
              textFilter: textFilterEnabled() ? textFilter : null,
            });
            return explainResponse(await fetch(input, prepared));
          },
        };
      },

      usage: usageOf,
      checkin: checkinOf,

      // Switches the user can turn on the provider's editor.
      options: [
        {
          key: "text-filter",
          label: "Filter configured prose before sending",
          default: true,
          description: "Uses content-filter.local.json; no guessed terms. Preserves recognized Markdown code, tool data and encrypted state. Reload after editing rules.",
        },
        {
          key: "portable-responses",
          label: "Replay complete Responses items inline",
          description: "Remove resource-local IDs only when inline content is available; preserve call_id and encrypted content. Reference-only history still requires the original resource. Off disables ID replay only; text-filter is independent.",
          default: true,
        },
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
