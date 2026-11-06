import { open } from "node:fs/promises";

const MARKER = "[FILTERED]";
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_TERMS = 128;
const MAX_TERM_LENGTH = 256;
const MAX_TOTAL_TERM_LENGTH = 8192;

function configurationError() {
  const error = new Error("AgentRouter text filter configuration is invalid or unreadable. Check content-filter.local.json; no request was sent. Rule contents are not logged.");
  error.code = "agent_router_text_filter_config";
  return error;
}

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Protect Markdown code rather than changing executable examples accidentally.
// An unclosed code delimiter conservatively protects the rest of the segment.
function inlineCodeRanges(text) {
  const ranges = [];
  const runs = /`+/g;
  let opening;
  while ((opening = runs.exec(text))) {
    let closing;
    while ((closing = runs.exec(text)) && closing[0].length !== opening[0].length) {}
    ranges.push([opening.index, closing ? runs.lastIndex : text.length]);
    if (!closing) break;
  }
  return ranges;
}

// Container fences have context-dependent indentation/closing rules. Without a
// full Markdown parser, preserve that whole field instead of risking code edits.
function codePrefix(line) {
  // Advance monotonically: nested whitespace regexes can backtrack exponentially
  // on innocent deeply quoted prose even when the request is only a few bytes.
  const space = char => char === " " || char === "\t";
  let position = 0, container = false, indented = false;
  while (position < line.length) {
    const start = position;
    while (space(line[position])) {
      if (line[position] === "\t") indented = true;
      position++;
    }
    if (position - start >= 4) indented = true;
    let end = position;
    if (line[position] === ">") end++;
    else if (["-", "+", "*"].includes(line[position]) && space(line[position + 1])) end++;
    else {
      while (line[end] >= "0" && line[end] <= "9") end++;
      if (end > position && [".", ")"].includes(line[end]) && space(line[end + 1])) end++;
      else end = position;
    }
    if (end === position) break;
    container = true;
    position = end;
    if (space(line[position])) position++; // One container separator is not code indentation.
  }
  return { indented, containerFence: container && (line.startsWith("```", position) || line.startsWith("~~~", position)) };
}

function hasContainerFence(text) {
  return text.split(/\r?\n/).some(line => codePrefix(line).containerFence);
}

// Keep structural separators with code, but leave indentation on the next
// nonblank line for that line's own Markdown classification.
function codeRangeWithBoundaries(text, start, end) {
  while (start > 0 && /[ \t\r\n]/.test(text[start - 1])) start--;
  let cursor = end;
  while (cursor < text.length) {
    let next = cursor;
    while (text[next] === " " || text[next] === "\t") next++;
    if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
    else if (text[next] === "\n") next++;
    else break;
    cursor = next;
  }
  return [start, cursor];
}

function outsideProseCode(text, replace) {
  // Collect ranges against the original text, not sliced suffixes: inline code
  // must not erase indentation, nor may indentation split a multiline code span.
  const inline = inlineCodeRanges(text);
  const protectedRanges = [...inline];
  // A literal rule may contain the marker; protecting only matches that start
  // with it still lets a longer rule consume a marker on a later pass.
  for (const marker of text.matchAll(/\[FILTERED\]/g)) {
    protectedRanges.push([marker.index, marker.index + marker[0].length]);
  }
  const paragraphs = text.split(/(\r?\n[ \t]*\r?\n)/);
  let position = 0, inlineIndex = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    let linePosition = position;
    for (const line of paragraph.split("\n")) {
      while (inlineIndex < inline.length && inline[inlineIndex][1] <= linePosition) inlineIndex++;
      const insideInline = inlineIndex < inline.length && inline[inlineIndex][0] <= linePosition;
      if (!insideInline && line.trim() && codePrefix(line).indented) {
        // Preserve both adjoining separators: consuming either can change the
        // next pass's Markdown classification even without touching code bytes.
        protectedRanges.push(codeRangeWithBoundaries(text, position, position + paragraph.length));
        break;
      }
      linePosition += line.length + 1;
    }
    position += paragraph.length;
  }
  protectedRanges.sort((left, right) => left[0] - right[0]);
  const output = [];
  position = 0;
  for (const [start, end] of protectedRanges) {
    if (start > position) output.push(replace(text.slice(position, start)));
    if (end > position) output.push(text.slice(Math.max(position, start), end));
    position = Math.max(position, end);
  }
  output.push(replace(text.slice(position)));
  return output.join("");
}

function outsideCode(text, replace) {
  if (hasContainerFence(text)) return text;
  const output = [];
  const fences = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/gm;
  let position = 0, opening = null, match;
  while ((match = fences.exec(text))) {
    if (!opening) {
      const start = Math.max(position, codeRangeWithBoundaries(text, match.index, match.index)[0]);
      output.push(outsideProseCode(text.slice(position, start), replace));
      opening = { index: start, marker: match[1] };
    } else if (match[1][0] === opening.marker[0] && match[1].length >= opening.marker.length && !match[2].trim()) {
      const end = codeRangeWithBoundaries(text, opening.index, fences.lastIndex)[1];
      output.push(text.slice(opening.index, end));
      position = fences.lastIndex = end;
      opening = null;
    }
  }
  output.push(opening ? text.slice(opening.index) : outsideProseCode(text.slice(position), replace));
  return output.join("");
}

// Literal, bounded rules only: no inferred vendor keywords and no user regex.
export function createTextFilter(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key => !["terms", "caseSensitive"].includes(key)) ||
      !Array.isArray(config.terms) || config.terms.length > MAX_TERMS ||
      (config.caseSensitive !== undefined && typeof config.caseSensitive !== "boolean") ||
      config.terms.some(term => typeof term !== "string" || !term.trim() || term.length > MAX_TERM_LENGTH) ||
      config.terms.reduce((total, term) => total + term.length, 0) > MAX_TOTAL_TERM_LENGTH) throw configurationError();
  if (!config.terms.length) return null;
  const terms = [...new Set(config.terms)].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`(${escapePattern(MARKER)})|${terms.map(escapePattern).join("|")}`, config.caseSensitive === false ? "giu" : "gu");
  return text => {
    let replacements = 0;
    const result = outsideCode(text, segment => segment.replace(pattern, (match, marker) => {
      if (marker) return match;
      replacements++;
      return MARKER;
    }));
    return { text: result, replacements };
  };
}

// Loaded when the provider loader is created. Editing the file requires a plugin
// reload. A missing file/empty list is off; a broken configured file is not ignored.
export async function loadTextFilter(path = new URL("./content-filter.local.json", import.meta.url)) {
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if (error.code === "ENOENT") return null; throw configurationError(); }
  try {
    if (!(await file.stat()).isFile()) throw configurationError();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_CONFIG_BYTES) throw configurationError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return createTextFilter(JSON.parse(text));
  } catch { throw configurationError(); }
  finally { await file.close(); }
}

// This is a narrowly scoped text transformation, not a data-loss prevention
// boundary: tool data, annotations, media and server-side/opaque history stay put.
export function redactResponsesBody(body, filter) {
  if (!filter || !body || typeof body !== "object" || Array.isArray(body)) return { body, replacements: 0 };
  let replacements = 0;
  const redact = text => { const result = filter(text); replacements += result.replacements; return result.text; };
  const part = value => {
    if (!value || typeof value !== "object" || !["input_text", "output_text"].includes(value.type) ||
        typeof value.text !== "string" || Object.keys(value).some(key =>
          !["type", "text", "annotations"].includes(key) &&
          !(value.type === "output_text" && key === "logprobs" && Array.isArray(value.logprobs) && !value.logprobs.length)) ||
        value.annotations != null && (!Array.isArray(value.annotations) || value.annotations.length)) return value;
    const text = redact(value.text);
    return text === value.text ? value : { ...value, text };
  };
  const message = item => {
    if (!item || typeof item !== "object" || (item.type != null && item.type !== "message") ||
        !["user", "assistant", "system", "developer"].includes(item.role) ||
        Object.keys(item).some(key => !["type", "id", "role", "content", "status", "phase"].includes(key))) return item;
    const before = replacements;
    const content = typeof item.content === "string" ? redact(item.content) : Array.isArray(item.content) ? item.content.map(part) : item.content;
    return replacements === before ? item : { ...item, content };
  };
  const input = typeof body.input === "string" ? redact(body.input) : Array.isArray(body.input) ? body.input.map(message) : body.input;
  const instructions = typeof body.instructions === "string" ? redact(body.instructions) : body.instructions;
  if (!replacements) return { body, replacements: 0 };
  const result = { ...body };
  if (Object.hasOwn(body, "input")) result.input = input;
  if (Object.hasOwn(body, "instructions")) result.instructions = instructions;
  return { body: result, replacements };
}
