// Keep GitHub session parsing local, bounded, and shared by prompts, saves, and check-in.
export const MAX_GITHUB_COOKIE_BYTES = 32 * 1024;

const INVALID_COOKIE = "请提供包含 user_session 或 __Host-user_session_same_site 的 GitHub 登录 Cookie；本站 Cookie、API Key、访问令牌和网页地址不能替代它";
const COOKIE_NAME = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const SESSION_NAMES = new Set(["user_session", "__Host-user_session_same_site"]);

function githubDomain(domain) {
  return domain === undefined || domain === "" ||
    (typeof domain === "string" && ["github.com", ".github.com"].includes(domain.toLowerCase()));
}

function exportedPairs(rows) {
  const pairs = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    if (!githubDomain(row.domain)) continue;
    pairs.push([row.name, row.value]);
  }
  return pairs;
}

function tablePairs(text) {
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    if (columns.length < 2) return undefined;
    if (columns[0] === "Name" && columns[1] === "Value" && columns[2] === "Domain") continue;
    // Browser devtools: name, value, domain, path, ...
    if (!githubDomain(columns[2])) continue;
    pairs.push([columns[0], columns[1]]);
  }
  return pairs;
}

export function parseGithubCookie(input = "") {
  if (typeof input !== "string") return { error: INVALID_COOKIE };
  if (Buffer.byteLength(input, "utf8") > MAX_GITHUB_COOKIE_BYTES) {
    return { error: "GitHub Cookie 最多支持 32 KiB，请只复制 GitHub 所需的 Cookie" };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/.test(input)) return { error: INVALID_COOKIE };
  const text = input.trim();
  if (!text) return { cookie: "" };
  let pairs;
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const rows = JSON.parse(text);
      if (Array.isArray(rows)) pairs = exportedPairs(rows);
    } catch { /* Never expose pasted values or JSON parse errors. */ }
  } else if (input.includes("\t")) {
    pairs = tablePairs(text);
  } else if (text && !/[\r\n]/.test(input)) {
    const header = text.replace(/^Cookie:\s*/i, "");
    pairs = header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
      const equals = part.indexOf("=");
      return equals > 0 ? [part.slice(0, equals), part.slice(equals + 1)] : [];
    });
  }
  if (!pairs?.length || pairs.some(([name, value]) =>
    typeof name !== "string" || typeof value !== "string" ||
    !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value))) {
    return { error: INVALID_COOKIE };
  }
  if (pairs.some(([name, value]) => name === "logged_in" && /^(no|false|0)$/i.test(value))) {
    return { error: "GitHub Cookie 包含已退出登录的标记，请在浏览器重新登录同一账号后复制" };
  }
  // Match the existing browser-cookie reader: the last value of a name wins.
  const cookies = new Map(pairs);
  if (![...SESSION_NAMES].some(name => cookies.get(name))) return { error: INVALID_COOKIE };
  return { cookie: [...cookies].map(([name, value]) => name + "=" + value).join("; ") };
}
