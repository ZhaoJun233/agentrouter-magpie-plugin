import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createTextFilter, loadTextFilter, redactResponsesBody } from "./content-filter.mjs";
import { prepareRequest } from "./request.mjs";

const url = "https://example.test/v1/responses";
const filter = () => createTextFilter({ terms: ["private-term", "内部词"] });
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "agentrouter-filter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("empty rules are disabled and invalid rules never echo their contents", () => {
  assert.equal(createTextFilter({ terms: [] }), null);
  for (const rules of [null, [], { terms: "private-term" }, { terms: [""] }, { terms: ["   "] }, { terms: [3] }, { terms: ["x".repeat(257)] }, { terms: Array(129).fill("private-term") }, { terms: ["private-term"], caseSensitive: "yes" }, { terms: ["private-term"], unknown: true }]) {
    assert.throws(() => createTextFilter(rules), error => error.code === "agent_router_text_filter_config" && !error.message.includes("private-term"));
  }
});

test("literal matching is longest-first, case-sensitive, Unicode-safe and non-cascading", () => {
  const redact = createTextFilter({ terms: ["a.b", "private", "private-term", "内部词", "FILTERED"] });
  assert.deepEqual(redact("a.b axb private-term PRIVATE 内部词 [FILTERED]"), { text: "[FILTERED] axb [FILTERED] PRIVATE [FILTERED] [FILTERED]", replacements: 3 });
  assert.deepEqual(redact(redact("private-term").text), { text: "[FILTERED]", replacements: 0 });
  assert.equal(createTextFilter({ terms: ["private-term"], caseSensitive: false })("PRIVATE-TERM").text, "[FILTERED]");
});

test("Markdown code spans, longer fences, tilde fences and unclosed fences stay intact", () => {
  const text = "private-term `private-term`\n````js\nprivate-term\n```\nprivate-term\n````\nprivate-term\n~~~\nprivate-term\n~~~\n`multi\nprivate-term` private-term\n```\nprivate-term";
  const result = filter()(text);
  assert.equal(result.replacements, 3);
  assert.equal(result.text, text.replace(/^private-term/, "[FILTERED]").replace("````\nprivate-term", "````\n[FILTERED]").replace("private-term` private-term", "private-term` [FILTERED]"));
});

test("ambiguous indented or container-nested code conservatively preserves its text field", () => {
  for (const text of ["before\n\n    private-term()\n\nafter", "\tprivate-term()", "> ~~~js\n> private-term()\n> ~~~", "- ~~~js\n  private-term()\n  ~~~", "> 1. ~~~js\n>    private-term()\n>    ~~~"]) {
    assert.deepEqual(filter()(text), { text, replacements: 0 });
  }
});

test("indented code paragraphs stay intact while surrounding prose is filtered", () => {
  for (const code of ["    private-term()", "\tprivate-term()", "  \tprivate-term()", ">     private-term()", "-     private-term()"]) {
    const text = `private-term\n\n${code}\n\nprivate-term`;
    assert.deepEqual(filter()(text), { text: `[FILTERED]\n\n${code}\n\n[FILTERED]`, replacements: 2 });
  }
  const text = "private-term `code\n    private-term\nmore private-term` private-term";
  assert.deepEqual(filter()(text), { text: text.replace(/^private-term/, "[FILTERED]").replace(/private-term$/, "[FILTERED]"), replacements: 2 });
});

test("backticks inside indented code cannot erase its original indentation context", () => {
  for (const code of ["    `x` private-term", "\t`x` private-term", ">     `x` private-term", "    const x = `hello`; // private-term"]) {
    assert.deepEqual(filter()(code), { text: code, replacements: 0 });
    assert.deepEqual(filter()(`private-term\n\n${code}\n\nprivate-term`), { text: `[FILTERED]\n\n${code}\n\n[FILTERED]`, replacements: 2 });
  }
});

test("deep quote prefixes cannot monopolize the event loop through backtracking", async t => {
  const moduleURL = new URL("./content-filter.mjs", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    import(${JSON.stringify(moduleURL)}).then(({ createTextFilter }) => {
      const result = createTextFilter({ terms: ["SAMPLE"] })((">   ").repeat(10000) + "SAMPLE");
      parentPort.postMessage({ replacements: result.replacements, filtered: result.text.endsWith("[FILTERED]") });
    });
  `, { eval: true });
  t.after(() => worker.terminate());
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("code-prefix scanning exceeded its regression budget")), 3000);
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.deepEqual(result, { replacements: 1, filtered: true });
  } finally { clearTimeout(timer); }
});

test("literal terms can cross ordinary paragraph breaks", () => {
  assert.deepEqual(createTextFilter({ terms: ["first\n\nsecond"] })("first\n\nsecond"), { text: "[FILTERED]", replacements: 1 });
});

test("Responses text is copied while tool arguments, outputs, schemas and opaque state remain intact", () => {
  const body = { instructions: "private-term", input: [
    { role: "user", content: "内部词", id: "private-term" },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "private-term", annotations: [] }, { type: "input_image", image_url: "private-term" }] },
    { type: "function_call", call_id: "private-term", name: "private-term", arguments: "private-term" },
    { type: "function_call_output", call_id: "private-term", output: "private-term" },
    { type: "reasoning", id: "private-term", summary: [{ type: "summary_text", text: "private-term" }], encrypted_content: "private-term" },
    { type: "compaction", encrypted_content: "private-term" },
    { type: "item_reference", id: "private-term" }
  ], tools: [{ description: "private-term", parameters: { private: "private-term" } }], previous_response_id: "private-term", conversation: "private-term", metadata: { label: "private-term" } };
  const before = structuredClone(body);
  const result = redactResponsesBody(body, filter());
  assert.equal(result.replacements, 3);
  assert.equal(result.body.instructions, "[FILTERED]");
  assert.equal(result.body.input[0].content, "[FILTERED]");
  assert.equal(result.body.input[0].id, "private-term");
  assert.equal(result.body.input[1].content[0].text, "[FILTERED]");
  assert.equal(result.body.input[1].phase, "commentary");
  assert.deepEqual(result.body.input.slice(2), before.input.slice(2));
  for (const key of ["tools", "metadata", "previous_response_id", "conversation"]) assert.deepEqual(result.body[key], before[key]);
  assert.deepEqual(body, before);
});

test("annotated, signed, unknown and tool-role content is not reinterpreted as prose", () => {
  const body = { input: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "private-term", annotations: [{ type: "url_citation", start_index: 0, end_index: 12 }] }] },
    { role: "user", content: [{ type: "input_text", text: "private-term", signature: "signature" }] },
    { role: "tool", content: "private-term" },
    { type: "unknown", role: "user", content: "private-term" }
  ] };
  assert.equal(redactResponsesBody(body, filter()).body, body);
});

test("string input is filtered without synthesizing missing history", () => {
  const body = { input: "private-term", store: true };
  assert.deepEqual(redactResponsesBody(body, filter()), { body: { input: "[FILTERED]", store: true }, replacements: 1 });
});

test("missing or empty local configuration does nothing; malformed and oversized files fail closed", async t => {
  const dir = await directory(t); const path = join(dir, "content-filter.local.json");
  assert.equal(await loadTextFilter(path), null);
  await writeFile(path, JSON.stringify({ terms: [] })); assert.equal(await loadTextFilter(path), null);
  await writeFile(path, JSON.stringify({ terms: ["private-term"] })); assert.equal((await loadTextFilter(path))("private-term").text, "[FILTERED]");
  for (const content of ["private-term not-json", " ".repeat(32769), Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, content);
    await assert.rejects(loadTextFilter(path), error => error.code === "agent_router_text_filter_config" && !error.message.includes("private-term"));
  }
});

test("request filtering is independent of portable replay and removes only stale integrity headers", async () => {
  const controller = new AbortController();
  const init = { method: "POST", body: JSON.stringify({ input: "private-term", store: true }), signal: controller.signal, headers: { "content-type": "application/json", "content-length": "50", "content-md5": "old", digest: "old", "content-digest": "old", "x-session-id": "stable" } };
  const after = await prepareRequest(url, init, { portableResponses: false, textFilter: filter() });
  assert.deepEqual(JSON.parse(after.body), { input: "[FILTERED]", store: true });
  assert.equal(after.signal, controller.signal);
  for (const name of ["content-length", "content-md5", "digest", "content-digest"]) assert.equal(after.headers.has(name), false);
  assert.equal(after.headers.get("x-session-id"), "stable");
  assert.equal(init.headers.digest, "old");
});

test("non-matches and unsupported request bodies are byte-identical", async () => {
  const original = { method: "POST", body: JSON.stringify({ input: "public text" }, null, 2) };
  assert.equal(await prepareRequest(url, original, { textFilter: filter() }), original);
  for (const init of [ { method: "GET", body: "private-term" }, { method: "POST", body: "not JSON private-term" }, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ input: "private-term" }) }, { method: "POST", headers: { "content-encoding": "gzip" }, body: "private-term" }, { method: "POST", body: JSON.stringify({ input: "private-term" + "x".repeat(4 * 1024 * 1024) }) } ]) {
    assert.equal(await prepareRequest(url, init, { textFilter: filter() }), init);
  }
  const other = { method: "POST", body: JSON.stringify({ input: "private-term" }) };
  assert.equal(await prepareRequest("https://example.test/v1/chat/completions", other, { textFilter: filter() }), other);
});

test("cloned Request filtering preserves the original stream", async () => {
  const body = JSON.stringify({ input: "private-term" });
  const request = new Request(url, { method: "POST", body });
  const result = await prepareRequest(request, { headers: { "content-type": "application/json" } }, { textFilter: filter() });
  assert.equal(JSON.parse(result.body).input, "[FILTERED]");
  assert.equal(await request.text(), body);
});

test("filtering and inline replay compose without dropping call IDs or changing opaque reasoning", async () => {
  const body = { input: [{ type: "message", role: "assistant", id: "msg_old", content: [{ type: "output_text", text: "private-term", annotations: [] }] }, { type: "reasoning", id: "rs_old", encrypted_content: "private-term", summary: [] }] };
  const result = JSON.parse((await prepareRequest(url, { method: "POST", body: JSON.stringify(body) }, { textFilter: filter() })).body);
  assert.equal(result.input[0].id, undefined); assert.equal(result.input[0].content[0].text, "[FILTERED]");
  assert.equal(result.store, false); assert.deepEqual(result.input[1], body.input[1]);
});

test("installed loader reads private rules, supports the off switch and never retries a blocked request", async t => {
  const dir = await directory(t);
  for (const file of ["index.mjs", "request.mjs", "response.mjs", "content-filter.mjs"]) await copyFile(new URL(file, import.meta.url), join(dir, file));
  await writeFile(join(dir, "content-filter.local.json"), JSON.stringify({ terms: ["private-term"] }));
  const plugin = (await import(pathToFileURL(join(dir, "index.mjs")).href)).default;
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0, sent;
  globalThis.fetch = async (_input, init) => { calls++; sent = init.body; return new Response(JSON.stringify({ error: { code: "content-blocked", message: "content-blocked" } }), { status: 400, headers: { "content-type": "application/json" } }); };
  const body = JSON.stringify({ input: "private-term" });
  for (const enabled of [true, false]) {
    const p = await plugin({ magpie: { option: (_provider, name) => name === "text-filter" ? enabled : false } });
    assert.ok(p.auth.options.some(option => option.key === "text-filter"));
    const loader = await p.auth.loader(async () => ({ type: "api", key: "test-key" }), {});
    const response = await loader.fetch(url, { method: "POST", body });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(sent).input, enabled ? "[FILTERED]" : "private-term");
  }
  assert.equal(calls, 2);
  await writeFile(join(dir, "content-filter.local.json"), "private-term invalid-json");
  const p = await plugin({});
  await assert.rejects(p.auth.loader(async () => ({ key: "test-key" }), {}), error => error.code === "agent_router_text_filter_config");
  assert.equal(calls, 2);
});
