import { readCloneText } from "./body-inspection.mjs";

// Some relays commit HTTP 200 before they know whether a model can answer.
// Inspect only the bounded SSE prelude, before any answer or tool call escapes.
// Success (including its original bytes), unknown events, and late failures pass
// through. Never retry here: magpie owns routing, the caller owns cancellation.
const PRELUDE_BYTES = 64 * 1024;
const PRELUDE_MS = 15_000;
const TOKEN_RATE_LIMIT = /exceeded\s+token\s+rate\s+limit/i;
const TRANSIENT_STATUSES = [429, 500, 502, 503, 504];
const TRANSIENT_CODES = ["rate_limit_exceeded", "server_error", "overloaded_error", "high_demand"];

const messageText = value => typeof value.message === "string" && value.message
  ? value.message : typeof value.msg === "string" ? value.msg : "";
const numericCode = value => typeof value === "number" ? value
  : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : null;

function hasNestedError(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    ("error" in value || (value.response != null && typeof value.response === "object" && "error" in value.response));
}

function hasErrorDetail(value) {
  return value != null && (messageText(value).trim().length > 0 || value.code === "content-blocked" ||
    [value.status, value.status_code, value.code].some(code => TRANSIENT_STATUSES.includes(numericCode(code))) ||
    [value.code, value.type].some(code => TRANSIENT_CODES.includes(code)));
}

function inheritErrorStatus(ancestor, detail) {
  if (!hasErrorDetail(detail)) return null;
  const status = Object.fromEntries(["status", "status_code", "code"]
    .filter(key => TRANSIENT_STATUSES.includes(numericCode(ancestor[key])))
    .map(key => [key, ancestor[key]]));
  return { ...status, ...detail };
}

function errorDetail(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") {
    try { return errorDetail(JSON.parse(value), depth + 1); }
    catch { return { message: value }; }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const message = messageText(value);
  const detail = message ? { ...value, message } : value;
  if (hasNestedError(value)) {
    const nested = errorDetail(value.error ?? value.response?.error, depth + 1);
    return inheritErrorStatus(value, nested);
  }
  if (!message) return detail;
  let encoded;
  try { encoded = JSON.parse(message); } catch { return detail; }
  const nested = errorDetail(encoded, depth + 1);
  // Exhaustion or an invalid encoded detail is not permission to use a partial parent.
  return inheritErrorStatus(value, nested);
}

function changedHeaders(original) {
  const h = new Headers(original);
  h.set("content-type", "application/json");
  // Fetch exposes decoded bytes, and the new body has a different length.
  for (const k of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"]) h.delete(k);
  return h;
}

function isBusinessError(e, depth = 0) {
  if (depth > 4 || e == null) return false;
  if (typeof e === "string") {
    try { return isBusinessError(JSON.parse(e), depth + 1); }
    catch { return isBusinessError({ message: e }, depth + 1); }
  }
  if (typeof e !== "object" || Array.isArray(e)) return false;
  if (isBusinessError(e.error ?? e.response?.error, depth + 1)) return true;
  const message = messageText(e);
  if (message) {
    try { if (isBusinessError(JSON.parse(message), depth + 1)) return true; } catch {}
  }
  if ([e.status, e.status_code, e.code].some(value => [401, 402, 403].includes(numericCode(value)))) return true;
  const tags = [e.code, e.type].filter(value => typeof value === "string").join(" ");
  if (/auth|permission|forbidden|invalid_api_key|quota|balance|billing|payment|content[-_]?(policy|filter|blocked)|moderation|safety/i.test(tags)) return true;
  return /invalid.{0,12}api.?key|unauthenticated|unauthorized|authentication|permission denied|forbidden|quota|balance|billing|payment required|content policy|content filter/i.test(message);
}

function transientFailureResponse(e, originalHeaders) {
  const numericStatus = [e.status, e.status_code, e.code].map(numericCode).find(value =>
    TRANSIENT_STATUSES.includes(value));
  const code = [e.code, e.type].find(value =>
    TRANSIENT_CODES.includes(value));
  const rateLimited = numericStatus === 429 || code === "rate_limit_exceeded";
  const busy = code === "overloaded_error" || code === "high_demand" ||
    /currently experiencing high demand/i.test(e.message ?? "");
  const status = numericStatus ?? (rateLimited ? 429 : busy ? 503 : code === "server_error" ? 500 : null);
  if (!status) return null;
  return new Response(JSON.stringify({ error: {
    code: e.code ?? status,
    type: rateLimited ? "agent_router_upstream_rate_limit" : busy ? "agent_router_upstream_busy" : "agent_router_upstream_error",
    message: rateLimited
      ? "AgentRouter 上游报告了速率限制。请按上游 Retry-After 等待，或稍后再试；插件未自动重试。"
      : busy ? "AgentRouter 上游当前繁忙。请稍后再试；插件未自动重试。"
        : "AgentRouter 上游报告了暂时性服务错误。请稍后再试；插件未自动重试。",
    upstream: typeof e.message === "string" ? e.message : "",
  } }), { status, headers: changedHeaders(originalHeaders) });
}

function failureResponse(value, originalHeaders) {
  const e = hasNestedError(value)
    ? inheritErrorStatus(value, errorDetail(value.error ?? value.response?.error, 1))
    : errorDetail(value);
  if (!e) return null;
  const message = typeof e.message === "string" ? e.message : "";
  const blocked = e.code === "content-blocked";
  const foreignItem = /requested item was created under a different[^.]{0,100}OpenAI resource/i.test(message);
  if (!blocked && !foreignItem && (isBusinessError(value) || isBusinessError(e))) return null;
  const capped = !blocked && !foreignItem && TOKEN_RATE_LIMIT.test(message);
  if (!capped && !blocked && !foreignItem) return transientFailureResponse(e, originalHeaders);
  const headers = changedHeaders(originalHeaders);
  if (capped && !headers.has("retry-after")) headers.set("retry-after", "60");
  const model = /requests to (\S+) for \S+/i.exec(message)?.[1];
  const id = /request id:\s*([A-Za-z0-9]+)/i.exec(message)?.[1];
  const trace = /trace_id[=:]([A-Za-z0-9_-]{1,128})/.exec(message)?.[1];
  const note = capped
    ? `AgentRouter${model ? ` 的 ${model}` : ""} 达到了上游 token 速率上限。请按 Retry-After 等待后重试；上游未提供等待时间时，插件建议一分钟后再试，不保证届时已恢复。不要立即重发同一请求。`
    : foreignItem
      ? `AgentRouter 的 Responses 历史条目属于另一个 OpenAI 资源${trace ? ` [trace_id=${trace}]` : ""}。请由客户端重发完整内联历史（store:false），或固定到创建该条目的同一上游资源；仅有 previous_response_id / item_reference 或不兼容的加密状态时，插件不能无损恢复。未自动重试。`
      : `AgentRouter 的内容过滤器拒绝了这段请求内容${id ? ` (request id: ${id})` : ""}。请改写被拒的部分，或改用其他服务商。`;
  return new Response(JSON.stringify({ error: {
    code: e.code ?? (capped ? "token_rate_limit" : foreignItem ? "resource_mismatch" : "content-blocked"),
    message: note,
    type: capped ? "agent_router_token_rate_limit" : foreignItem ? "agent_router_resource_mismatch" : "agent_router_content_blocked",
    upstream: message,
  } }), { status: capped ? 429 : 400, headers });
}

function emptyResponse(headers) {
  return new Response(JSON.stringify({ error: {
    code: "empty_response",
    type: "agent_router_empty_response",
    message: "AgentRouter 返回了空的完成事件（没有输出且用量为零），本次没有得到有效回答。",
  } }), { status: 502, headers: changedHeaders(headers) });
}

function hasArrayOutput(value) {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function hasStringOutput(value) {
  return value !== undefined && (typeof value !== "string" || value.length > 0);
}

function hasPartOutput(part) {
  if (!part || typeof part !== "object") return true;
  if (!["output_text", "summary_text", "refusal"].includes(part.type)) return true;
  if (Object.keys(part).some(key => !["type", "text", "refusal", "annotations", "logprobs"].includes(key))) return true;
  return hasStringOutput(part.text) || hasStringOutput(part.refusal) ||
    hasArrayOutput(part.annotations) || hasArrayOutput(part.logprobs);
}

function hasOutput(item) {
  if (!item || typeof item !== "object") return true;
  if (item.type !== "message" && item.type !== "reasoning") return true;
  if (Object.keys(item).some(key => !["type", "id", "role", "status", "content", "summary"].includes(key))) return true;
  for (const key of ["content", "summary"]) {
    if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some(hasPartOutput))) return true;
  }
  return false;
}

function hasChatOutput(choice) {
  if (!choice || typeof choice !== "object") return true;
  if (Object.keys(choice).some(key => !["index", "delta", "message", "finish_reason", "logprobs"].includes(key))) return true;
  const delta = choice.delta ?? choice.message ?? {};
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return true;
  if (Object.keys(delta).some(key => !["role", "content", "refusal", "reasoning", "reasoning_content", "tool_calls", "function_call"].includes(key))) return true;
  return (delta.role !== undefined && delta.role !== "assistant") ||
    [delta.content, delta.refusal, delta.reasoning, delta.reasoning_content].some(hasStringOutput) ||
    hasArrayOutput(delta.tool_calls) || (delta.function_call !== undefined && delta.function_call !== null) ||
    (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "") ||
    (choice.logprobs !== undefined && choice.logprobs !== null);
}

// null means harmless prelude; true means release unchanged; Response is an
// explicit early failure. Looking only in error envelopes avoids matching text
// in a perfectly good answer that quotes an error message.
function inspectEvent(frame, headers) {
  const lines = frame.split(/\r\n|\n|\r/);
  let name;
  const dataLines = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value; // SSE uses the last field, including an empty one.
    if (field === "data") dataLines.push(value);
  }
  const data = dataLines.join("\n");
  if (!data) return lines.every(line => !line || line.startsWith(":")) ? null : true;
  if (data === "[DONE]") return true;
  let j;
  try { j = JSON.parse(data); } catch { return true; }
  if (!j || typeof j !== "object") return true;
  const type = j.type ?? name;
  const knownTypes = ["message", "error", "response.failed", "response.completed", "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added"];
  const namedFailure = name === "error" || name === "response.failed";
  if (name && !knownTypes.includes(name)) return true;
  if (!namedFailure && type && !knownTypes.includes(type)) return true;
  if (typeof j.delta === "string" && j.delta) return true;
  if (j.item && hasOutput(j.item)) return true;
  if (j.part && hasPartOutput(j.part)) return true;
  if (Array.isArray(j.response?.output) && j.response.output.some(hasOutput)) return true;
  if (Array.isArray(j.choices) && j.choices.some(hasChatOutput)) return true;
  const error = j.error ?? j.response?.error ?? ((type === "error" || type === "response.failed" || name === "error" || name === "response.failed") ? j : null);
  if (error) return failureResponse(j, headers) ?? true;
  if (type === "response.completed") {
    const r = j.response;
    if (r?.status === "completed" && Array.isArray(r.output) && r.output.length === 0 &&
        r.usage?.input_tokens === 0 && r.usage?.output_tokens === 0) return emptyResponse(headers);
    return true;
  }
  if (Array.isArray(j.choices)) return null; // known chat role-only/usage prelude
  if (["response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added"].includes(type)) return null;
  return true; // unknown protocol or event: fail open, not data loss
}

// CR ends a line immediately; a following LF (even in the next chunk) belongs
// to that same ending. This also handles legal mixed newline event separators.
function eventScanner(headers) {
  let line = "", lines = [], afterCR = false;
  return text => {
    for (const char of text) {
      if (afterCR && char === "\n") { afterCR = false; continue; }
      afterCR = false;
      if (char !== "\r" && char !== "\n") { line += char; continue; }
      afterCR = char === "\r";
      if (line) { lines.push(line); line = ""; continue; }
      const result = inspectEvent(lines.join("\n"), headers);
      lines = [];
      if (result !== null) return result;
    }
    return null;
  };
}

async function inspectStream(res) {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  const scan = eventScanner(res.headers);
  let bytes = 0, inflight, timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), PRELUDE_MS); });
  const cancel = reason => { void reader.cancel(reason).catch(() => {}); };
  // Keep the in-flight read if the inspection deadline expires. A fresh read
  // would skip that chunk; a tee/clone would buffer an unbounded unused branch.
  try {
    while (true) {
      inflight = reader.read();
      const next = await Promise.race([inflight, expired]);
      if (next === null) break;
      inflight = null;
      if (next.done) break;
      chunks.push(next.value);
      bytes += next.value.byteLength;
      if (bytes > PRELUDE_BYTES) break;
      const result = scan(decoder.decode(next.value, { stream: true }));
      if (result instanceof Response) { cancel("early upstream failure"); return result; }
      if (result === true) return replay();
    }
    return replay();
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  function replay() {
    let i = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (i < chunks.length) { controller.enqueue(chunks[i++]); return; }
        try {
          const next = await (inflight ?? reader.read());
          inflight = null;
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel,
    }), { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}

export async function explainResponse(res) {
  if (!res) return res;
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 200 && /text\/event-stream/i.test(type)) return inspectStream(res);
  if (![200, 400, 429].includes(res.status)) return res;
  // JSON success responses can also carry an error envelope. Ordinary successful
  // replies, unknown failures and non-JSON content remain untouched.
  if (res.status === 200 && !/\bjson\b/i.test(type)) return res;
  const text = await readCloneText(res, { maxBytes: 64 * 1024, timeoutMs: 2000 });
  if (text === null) return res;
  let j;
  try { j = JSON.parse(text); } catch { return res; }
  const error = j?.error ?? j?.response?.error ??
    ((res.status >= 400 || j?.type === "error" || j?.type === "response.failed") ? j : null);
  return error ? failureResponse(j, res.headers) ?? res : res;
}
