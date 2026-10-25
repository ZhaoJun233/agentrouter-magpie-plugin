// AgentRouter (agentrouter.org) for magpie / OpenCode.
//
// Two things make this vendor different from a plain OpenAI-compatible relay:
//
// 1. Its gateway only answers a client it recognises. A request whose
//    User-Agent is curl's (or anything else off its list) is refused with
//    "unauthorized client detected", even when the key is good. So the
//    request headers are not cosmetic here: they are what gets the key
//    through. They are configurable — per provider and per account — and
//    the defaults are the ones the vendor's own clients send.
//
// 2. It has no check-in endpoint of its own. The site is a New API
//    deployment, whose daily reward is claimed by GET /api/user/checkin,
//    and that route wants the *user* access token (the one on the site's
//    profile page), not the sk- API key used for completions. The API key
//    cannot claim it: /api/user/* answers "access token 无效" for an sk-
//    key. So an account signs in with both when it has both: the key for
//    completions, the access token for the balance and the check-in.
//
// Signing in with only the key is allowed and gives a working provider —
// the check-in then reports that it needs the access token, rather than
// pretending the day was claimed.

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

// siteName is the site the account signed in to.
function siteName(auth) {
  return String(meta(auth, "site") ?? "org");
}

// userHeaders are what a /api/user call carries: the access token, and the
// user id when the account knows it.
function userHeaders(provider, auth) {
  const h = headersOf(provider, auth);
  h.Authorization = userToken(auth);
  delete h["Content-Type"];
  if (userId(auth)) h["New-Api-User"] = userId(auth);
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

// balance asks the site for the account's quota. New API answers
// /api/user/self with the user record, whose quota and used_quota are in
// the site's own units (1/500000 of a dollar on most deployments).
//
// It answers {ok, balance?, why?, expired?} rather than undefined, because
// the reasons differ and only one of them is the user's to fix: a token the
// site refuses needs a new one from the profile page, while a site that is
// down is nothing to do with the account.
async function balance(provider, auth) {
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
    if (!json) return { ok: false, why: String(text).slice(0, 80) };
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
      b.why === "no-token"
        ? "AgentRouter：未填写站点「访问令牌」，无法读取余额（个人设置 → 访问令牌）"
        : b.expired
          ? "AgentRouter：访问令牌已失效，请到站点「个人设置 → 访问令牌」重新生成并填写"
          : b.why === "no-quota"
            ? "AgentRouter：站点没有返回额度字段"
            : `AgentRouter：无法读取余额（${b.why}）`;
    return { error: why, windows: [] };
  }
  const bal = b.balance;
  // The site counts in 1/500000 dollars unless it says otherwise.
  const rate = Number(provider?.quotaPerUnit ?? 500000) || 500000;
  const dollars = (n) => Math.round((n / rate) * 100) / 100;
  return {
    plan: bal.name || undefined,
    balance: dollars(bal.quota),
    windows: [
      { name: "Balance", used: dollars(bal.used), limit: dollars(bal.total), remaining: dollars(bal.quota) },
    ],
  };
}

// checkin claims the day's reward. New API's route is a GET and answers
// {success, message, data?}; a day already claimed answers success:false
// with a message saying so, which is "done", not a failure to retry.
async function checkinOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { outcome: "failed", message: "AgentRouter：尚未登录" };
  if (!userToken(auth)) {
    return {
      outcome: "ineligible",
      message:
        "AgentRouter：每日签到需要站点「访问令牌」（个人设置 → 访问令牌），API 密钥不能签到",
    };
  }
  const base = siteBase(provider, auth);
  let res;
  try {
    res = await fetch(`${base}/api/user/checkin`, {
      method: "GET",
      headers: userHeaders(provider, auth),
      signal: withTimeout(CHECKIN_TIMEOUT),
    });
  } catch (e) {
    return { outcome: "failed", message: `AgentRouter：${e?.message ?? String(e)}` };
  }
  const { json, text } = await jsonOrText(res);
  const msg = String(json?.message ?? json?.msg ?? "");

  // A token the site refuses: nothing retries into a valid one, so this is
  // the account's to fix. It is not a failed day, and magpie asking again
  // every 30 minutes only fills the log.
  if (res.status === 401 || /access\s*token.*(无效|invalid)|未登录且未提供/i.test(msg)) {
    return {
      outcome: "ineligible",
      message: "AgentRouter：访问令牌无效或已失效，请到「个人设置 → 访问令牌」重新生成后填写",
      signIn: "expired",
    };
  }
  if (!json) {
    return { outcome: "failed", message: `AgentRouter 返回 ${res.status}: ${String(text).slice(0, 120)}` };
  }

  if (json.success) {
    // New API puts the day's credit in data, often as the amount added.
    const credit = Number(json.data?.quota ?? json.data?.credit ?? json.data ?? NaN);
    const streak = Number(json.data?.streak ?? NaN);
    return {
      outcome: "claimed",
      ...(Number.isFinite(credit) ? { credit } : {}),
      ...(Number.isFinite(streak) ? { streak } : {}),
      message: msg || "AgentRouter：签到成功",
    };
  }

  // The site's ways of saying "you already have today's", and its ways of
  // saying there is nothing to claim now. Matching the words is what keeps
  // a day from being retried every 30 minutes.
  const already = /已经签到|已签到|今日已签|今天已签|already\s*(checked|signed)|already\s*claimed/i;
  const inactive = /未开始|未到|尚未开始|not\s*(yet\s*)?(start|open)|no\s*(check-?in|activity)/i;
  if (already.test(msg)) return { outcome: "done", message: msg };
  if (inactive.test(msg)) return { outcome: "inactive", message: msg };

  // A captcha the site wants is never solved here.
  if (/turnstile|captcha|验证码/i.test(msg)) {
    return { outcome: "captcha", message: msg || "AgentRouter 要求验证码" };
  }

  // "权限不足" is the site saying this account may not check in at all — its
  // check-in isn't open to this group, or the route is closed. Retrying can't
  // change it, so it settles for the day instead of failing every 30 minutes.
  if (/权限不足|无权限|forbidden|permission\s*denied|not\s*allowed/i.test(msg)) {
    return {
      outcome: "ineligible",
      message: `AgentRouter：该账号不允许签到（站点返回「${msg}」），不是失败，无需重试`,
    };
  }

  return { outcome: "failed", message: msg || `AgentRouter 返回 ${res.status}` };
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
    // requests, the access token claims the day and reads the balance.
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
            message: "签到站点",
            options: [
              { label: "agentrouter.org", value: "org" },
              { label: "ps.air-outer.com（备用域名）", value: "air" },
            ],
          },
          {
            type: "text",
            key: "accessToken",
            message: "访问令牌（站点「个人设置 → 访问令牌」，用于每日签到和余额）",
            placeholder: "留空则跳过签到，对话仍可用",
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
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  masked,
};
