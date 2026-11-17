// Gateway-side adaptation of the supplied offline repair rules. No session
// files or databases are opened; only known items in a sending copy are cleaned.
const SERVER_ID = /^[a-z][a-z0-9]*_[0-9a-f]{16,}$/i;
const KNOWN_ITEMS = new Set(["message", "agent_message", "reasoning", "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);
const BINDING_FIELDS = ["encrypted_content", "encrypted_function_args", "previous_response_id"];

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isServerId = value => typeof value === "string" && SERVER_ID.test(value);

export class SessionRepairError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionRepairError";
    this.code = code;
  }
}

function emptyInputError() {
  return new SessionRepairError("agent_router_session_repair_empty_input",
    "会话资源清理后没有可发送的输入。请关闭清理开关，或新建会话并补充必要上下文；未发送请求。");
}

function cleanItem(item) {
  const kind = item.type;
  // The Responses schema requires a reasoning ID. Dropping resource-bound
  // reasoning avoids manufacturing an invalid ID-less item in this lossy mode.
  if (kind === "compaction" || kind === "item_reference" || kind === "reasoning" &&
      (item.encrypted_content || isServerId(item.id))) return null;
  const message = kind === "message" || kind === "agent_message" || kind == null && MESSAGE_ROLES.has(item.role);
  if (!message && !KNOWN_ITEMS.has(kind)) return item;

  const toolCall = kind === "function_call" || kind === "custom_tool_call";
  const toolOutput = kind === "function_call_output" || kind === "custom_tool_call_output";
  const resourceBound = isServerId(item.id) || BINDING_FIELDS.some(field => Object.hasOwn(item, field));
  const callIdPresent = typeof item.call_id === "string" && item.call_id.length > 0;
  const argumentsText = kind === "custom_tool_call" ? item.input : item.arguments;
  const replayableCall = callIdPresent && typeof item.name === "string" && item.name.length > 0 &&
    typeof argumentsText === "string";
  const replayableOutput = callIdPresent && (typeof item.output === "string" || Array.isArray(item.output));
  if (resourceBound && (toolCall && !replayableCall || toolOutput && !replayableOutput)) {
    throw new SessionRepairError("agent_router_session_repair_opaque_tool",
      "工具调用或结果缺少可重放的明文数据或关联，无法安全清理。请关闭会话资源清理，或新建会话；未发送请求。");
  }

  let changed = false;
  const cleaned = { ...item };
  for (const field of BINDING_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    delete cleaned[field];
    changed = true;
  }
  if (isServerId(item.id)) {
    delete cleaned.id;
    if (message) delete cleaned.status;
    changed = true;
  }
  if (message && Array.isArray(item.content)) {
    const content = item.content.filter(part => !isObject(part) || part.type !== "encrypted_content");
    if (!content.length && (item.content.length || item.encrypted_content || isServerId(item.id))) return null;
    if (content.length !== item.content.length) {
      cleaned.content = content;
      changed = true;
    }
  } else if (message && (item.encrypted_content || isServerId(item.id)) &&
      !(typeof item.content === "string" && item.content.length)) {
    return null;
  }
  return changed ? cleaned : item;
}

export function repairSessionResources(body) {
  const unchanged = { body, changed: false };
  // Conversations and unknown input representations have separate contracts.
  // Do not try to reconstruct server-side or future history from them.
  if (!isObject(body) || body.conversation || !(typeof body.input === "string" ||
      Array.isArray(body.input) && body.input.every(isObject))) return unchanged;
  let changed = Object.hasOwn(body, "previous_response_id");
  let input = body.input;
  if (Array.isArray(input)) {
    const kept = [];
    for (const item of input) {
      const cleaned = cleanItem(item);
      if (cleaned !== item) changed = true;
      if (cleaned !== null) kept.push(cleaned);
    }
    if (changed) input = kept;
  }
  if (!changed) return unchanged;
  if (typeof input === "string" ? !input.trim() : !input.length) throw emptyInputError();
  const cleaned = { ...body, input };
  delete cleaned.previous_response_id;
  return { body: cleaned, changed: true };
}
