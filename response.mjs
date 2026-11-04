// Some relays commit HTTP 200 before they know whether a model can answer.
// Inspect only the bounded SSE prelude, before any answer or tool call escapes.
// Success (including its original bytes), unknown events, and late failures pass
// through. Never retry here: magpie owns routing, the caller owns cancellation.
const PRELUDE_BYTES = 64 * 1024;
const PRELUDE_MS = 15_000;
const TOKEN_RATE_LIMIT = /exceeded\s+token\s+rate\s+limit/i;

function errorDetail(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") {
    try { return errorDetail(JSON.parse(value), depth + 1); }
    catch { return { message: value }; }
  }
  if (typeof value !== "object") return null;
  if (value.error != null) return errorDetail(value.error, depth + 1);
  const nested = typeof value.message === "string" ? errorDetail(value.message, depth + 1) : null;
  return { ...value, ...nested };
}

function changedHeaders(original) {
  const h = new Headers(original);
  h.set("content-type", "application/json");
  // Fetch exposes decoded bytes, and the new body has a different length.
  for (const k of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"]) h.delete(k);
  return h;
}

function failureResponse(value, originalHeaders) {
  const e = errorDetail(value);
  if (!e) return null;
  const message = typeof e.message === "string" ? e.message : "";
  const capped = TOKEN_RATE_LIMIT.test(message);
  const blocked = e.code === "content-blocked";
  if (!capped && !blocked) return null;
  const headers = changedHeaders(originalHeaders);
  if (capped && !headers.has("retry-after")) headers.set("retry-after", "60");
  const model = /requests to (\S+) for \S+/i.exec(message)?.[1];
  const id = /request id:\s*([A-Za-z0-9]+)/i.exec(message)?.[1];
  const note = capped
    ? `AgentRouter${model ? ` 的 ${model}` : ""} 达到了上游 token 速率上限。请按 Retry-After 等待后重试；上游未提供等待时间时，插件建议一分钟后再试，不保证届时已恢复。不要立即重发同一请求。`
    : `AgentRouter 的内容过滤器拒绝了这段请求内容${id ? ` (request id: ${id})` : ""}。请改写被拒的部分，或改用其他服务商。`;
  return new Response(JSON.stringify({ error: {
    code: e.code ?? (capped ? "token_rate_limit" : "content-blocked"),
    message: note,
    type: capped ? "agent_router_token_rate_limit" : "agent_router_content_blocked",
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

function hasOutput(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type !== "message" && item.type !== "reasoning") return true;
  const content = Array.isArray(item.content) ? item.content : [];
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return [...content, ...summary].some(p => p?.text || p?.refusal);
}

// null means harmless prelude; true means release unchanged; Response is an
// explicit early failure. Looking only in error envelopes avoids matching text
// in a perfectly good answer that quotes an error message.
function inspectEvent(frame, headers) {
  const lines = frame.split(/\r\n|\n|\r/);
  const name = lines.find(s => s.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter(s => s.startsWith("data:")).map(s => s.slice(5).replace(/^ /, "")).join("\n");
  if (!data) return null;
  if (data === "[DONE]") return true;
  let j;
  try { j = JSON.parse(data); } catch { return true; }
  if (!j || typeof j !== "object") return true;
  const type = j.type ?? name;
  const error = j.error ?? j.response?.error ?? ((type === "error" || type === "response.failed" || name === "error" || name === "response.failed") ? j : null);
  if (error) return failureResponse(error, headers) ?? true;
  if (type === "response.completed") {
    const r = j.response;
    if (r?.status === "completed" && Array.isArray(r.output) && r.output.length === 0 &&
        r.usage?.input_tokens === 0 && r.usage?.output_tokens === 0) return emptyResponse(headers);
    return true;
  }
  if (typeof j.delta === "string" && j.delta) return true;
  if (j.item && hasOutput(j.item)) return true;
  if (j.part && (j.part.text || j.part.refusal)) return true;
  if (Array.isArray(j.response?.output) && j.response.output.some(hasOutput)) return true;
  if (Array.isArray(j.choices)) {
    for (const c of j.choices) {
      if (!c || typeof c !== "object") return true;
      const d = c.delta ?? c.message ?? {};
      if (d.content || d.refusal || d.reasoning || d.reasoning_content || d.tool_calls?.length || d.function_call || c.finish_reason) return true;
    }
    return null; // chat role-only/usage prelude
  }
  if (["response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.content_part.added"].includes(type)) return null;
  return true; // unknown protocol or event: fail open, not data loss
}

async function inspectStream(res) {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let bytes = 0, pending = "", inflight, timer;
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
      pending += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const result = inspectEvent(frame, res.headers);
        if (result instanceof Response) { cancel("early upstream failure"); return result; }
        if (result === true) return replay();
      }
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
  let j;
  try { j = await res.clone().json(); } catch { return res; }
  const error = j?.error ?? j?.response?.error ??
    ((res.status >= 400 || j?.type === "error" || j?.type === "response.failed") ? j : null);
  return error ? failureResponse(error, res.headers) ?? res : res;
}
