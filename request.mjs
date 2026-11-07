import { redactResponsesBody } from "./content-filter.mjs";
import { readCloneText } from "./body-inspection.mjs";

// Replay complete items inline instead of asking a load-balanced resource to
// retrieve them by an old item ID. Never remove call_id or opaque contents.
function isInlinePart(part) {
  if (!part || typeof part !== "object") return false;
  if (["input_text", "input_image", "input_file", "input_audio"].includes(part.type)) return true;
  if (part.type !== "output_text" || typeof part.text !== "string") return false;
  // The gateway also emits logprobs: [] on ordinary completed text. Empty
  // probability metadata adds no content; populated or unknown data stays intact.
  return Object.keys(part).every(key => ["type", "text", "annotations", "logprobs"].includes(key)) &&
    (part.annotations == null || Array.isArray(part.annotations) && part.annotations.length === 0) &&
    (!Object.hasOwn(part, "logprobs") || Array.isArray(part.logprobs) && part.logprobs.length === 0);
}

function hasInlineContent(item) {
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case undefined:
    case "message":
      return ["user", "assistant", "system", "developer"].includes(item.role) &&
        Object.keys(item).every(key => ["type", "id", "role", "content", "status", "phase"].includes(key)) &&
        (typeof item.content === "string" && item.content.length > 0 ||
          Array.isArray(item.content) && item.content.length > 0 && item.content.every(isInlinePart));
    case "function_call":
      return typeof item.call_id === "string" && item.call_id.length > 0 &&
        typeof item.name === "string" && item.name.length > 0 && typeof item.arguments === "string";
    case "function_call_output":
      return typeof item.call_id === "string" && item.call_id.length > 0 &&
        (typeof item.output === "string" || Array.isArray(item.output));
    // Reasoning IDs are required by the published input schema; encrypted
    // state has no cross-resource portability guarantee. Preserve it intact.
    case "reasoning":
      return false;
    default:
      return false;
  }
}

const MAX_BODY = 4 * 1024 * 1024;

export async function prepareResponsesRequest(input, init = {}) {
  return prepareRequest(input, init);
}

export async function prepareRequest(input, init = {}, { portableResponses = true, textFilter = null } = {}) {
  if (!portableResponses && !textFilter) return init;
  const request = input instanceof Request ? input : null;
  let pathname;
  try { pathname = new URL(request ? request.url : input).pathname; } catch { return init; }
  if (!pathname.endsWith("/responses") || (init.method ?? request?.method ?? "GET").toUpperCase() !== "POST") return init;
  const headers = new Headers(request?.headers);
  new Headers(init.headers ?? {}).forEach((v, k) => headers.set(k, v));
  if (headers.has("content-encoding") && headers.get("content-encoding").toLowerCase() !== "identity") return init;
  const mediaType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json")) return init;
  let text = init.body;
  if (text == null && request) text = await readCloneText(request, {
    maxBytes: MAX_BODY, timeoutMs: 2000, signal: init.signal ?? request.signal,
  });
  if (typeof text !== "string" || text.length > MAX_BODY || new TextEncoder().encode(text).byteLength > MAX_BODY) return init;
  let body;
  try { body = JSON.parse(text); } catch { return init; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return init;
  const filtered = redactResponsesBody(body, textFilter);
  body = filtered.body;
  const replayed = portableResponses && replayInline(body);
  if (!filtered.replacements && !replayed) return init;
  if (replayed) body.store = false;
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) headers.delete(name);
  return { ...init, body: JSON.stringify(body), headers };
}

function replayInline(body) {
  // Pointers carry context we cannot retrieve. Filtering visible prose must not
  // silently discard that context or turn a continuation into a new conversation.
  if (!Array.isArray(body.input) || body.previous_response_id || body.conversation ||
      body.input.some(item => item?.type === "item_reference")) return false;
  let changed = false;
  for (const item of body.input) {
    if (!hasInlineContent(item) || !Object.hasOwn(item, "id")) continue;
    delete item.id;
    if (item.type === "message" || item.type == null) {
      // Output-message input objects require an ID. Convert to the supported
      // EasyInputMessage form, preserving phase and every actual text segment.
      // Assistant history keeps output_text and its metadata; other roles use input_text.
      delete item.status;
      if (item.role !== "assistant" && Array.isArray(item.content)) item.content = item.content.map(part =>
        part.type === "output_text" ? { type: "input_text", text: part.text } : part);
    }
    changed = true;
  }
  return changed;
}
