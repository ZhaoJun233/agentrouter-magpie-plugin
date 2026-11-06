import test from "node:test";
import assert from "node:assert/strict";
import { explainResponse } from "./response.mjs";

const busy = "We are currently experiencing high demand";
const success = [{ type: "message", content: [{ type: "output_text", text: "success" }] }];
const cases = [
  { message: busy, error: {} },
  { code: 503, error: {}, output: success },
  { status: 429, response: { error: {} }, output: success },
  { message: busy, error: { code: "unknown_business_code" } },
];
for (const [index, payload] of cases.entries()) {
  test("explicit error boundary excludes unrelated JSON wrapper metadata " + index, async () => {
    const source = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    assert.equal(await explainResponse(source), source);
    assert.deepEqual(await source.json(), payload);
  });
  test("explicit error boundary excludes unrelated SSE wrapper metadata " + index, async () => {
    const bytes = new TextEncoder().encode("event: error\ndata: " + JSON.stringify(payload) + "\n\n");
    const source = new Response(bytes, { headers: { "content-type": "text/event-stream" } });
    const result = await explainResponse(source);
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  });
}

test("selected explicit error retains detail metadata and conservative outer business veto", async () => {
  for (const [payload, status] of [
    [{ code: 401, error: { code: 503, message: "busy" } }, 200],
    [{ error: { status: 503, message: "busy" } }, 503],
    [{ error: { code: 503, error: { message: "busy" } } }, 503],
    [{ response: { error: { code: "server_error", message: "failure" } } }, 500],
  ]) {
    const source = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    assert.equal((await explainResponse(source)).status, status);
  }
});

test("invalid or detail-less nested errors cannot inherit wrapper transient fields", async () => {
  for (const error of [{}, [], true, 5, { message: {} }, { code: "new_error" }, { status: 418 }]) {
    const payload = { status: 503, message: "We are currently experiencing high demand", error };
    const source = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    assert.equal(await explainResponse(source), source, JSON.stringify(error));
  }
});

test("bounded error inspection fails open at exhaustion instead of using partial ancestors", async () => {
  const wrap = (leaf, count) => { let result = leaf; while (count--) result = { error: result }; return result; };
  for (const [payload, status] of [
    [{ error: wrap({ code: "server_error", message: "failure" }, 3) }, 500],
    [{ error: wrap({ code: "server_error", message: "failure" }, 4) }, 200],
    [{ error: { status: 503, error: wrap({ code: "insufficient_quota" }, 8) } }, 200],
    [{ error: { status: 503, message: JSON.stringify(wrap({ code: "insufficient_quota" }, 8)) } }, 200],
  ]) {
    const source = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    const result = await explainResponse(source);
    assert.equal(result.status, status);
    if (status === 200) assert.equal(result, source);
  }
});

test("SSE last event field and optional single space determine the observation boundary", async () => {
  for (const [fields, status] of [
    ["event: error\nevent: custom.signal", 200],
    ["event: custom.signal\nevent: error", 429],
    ["event: error\nevent", 200],
    ["event: error\nevent:", 200],
    ["event: error ", 200],
    ["event:  error", 200],
    ["event:\terror", 200],
    ["event:error", 429],
  ]) {
    const text = fields + '\ndata: {"message":"exceeded token rate limit"}\n\n';
    const source = new Response(text, { headers: { "content-type": "text/event-stream" } });
    const result = await explainResponse(source);
    assert.equal(result.status, status, fields);
    if (status === 200) assert.equal(await result.text(), text);
  }
});

test("SSE unknown-shaped values under known fields release before a later failure", async () => {
  const late = 'event: error\ndata: {"message":"exceeded token rate limit"}\n\n';
  const payloads = [];
  for (const value of [null, {}, 0, false, "", { opaque: "retain-me" }]) {
    for (const field of ["annotations", "logprobs"]) payloads.push({ type: "response.content_part.added", part: { type: "output_text", text: "", [field]: value } });
    payloads.push({ choices: [{ delta: { tool_calls: value } }] });
  }
  payloads.push({ type: "response.content_part.added", part: { type: "output_text", text: 0 } });
  payloads.push({ choices: [{ delta: { content: 0 } }] });
  payloads.push({ type: "response.output_item.added", item: { type: "message", content: null } });
  for (const payload of payloads) {
    const text = "data: " + JSON.stringify(payload) + "\n\n" + late;
    const source = new Response(text, { headers: { "content-type": "text/event-stream" } });
    const result = await explainResponse(source);
    assert.equal(result.status, 200, JSON.stringify(payload));
    assert.equal(await result.text(), text);
  }
  for (const payload of [
    { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [], logprobs: [] } },
    { choices: [{ delta: { role: "assistant", tool_calls: [] } }] },
  ]) {
    const source = new Response("data: " + JSON.stringify(payload) + "\n\n" + late, { headers: { "content-type": "text/event-stream" } });
    assert.equal((await explainResponse(source)).status, 429);
  }
});

test("every nested error boundary rejects empty or unknown leaves without borrowing wrapper prose", async () => {
  for (const leaf of [{}, [], null, 5, true, { code: "unknown_business_code" }, { status: 418 }, { message: " " }]) {
    for (const error of [
      { message: "currently experiencing high demand", error: leaf },
      { code: 503, error: leaf },
      { status: 503, message: JSON.stringify({ error: leaf }) },
      { status: 503, response: { error: leaf } },
    ]) {
      const body = JSON.stringify({ error });
      const source = new Response(body, { headers: { "content-type": "application/json" } });
      assert.equal(await explainResponse(source), source, body);
      assert.equal(await source.text(), body);
      const text = "event: error\ndata: " + body + "\n\n";
      const stream = new Response(text, { headers: { "content-type": "text/event-stream" } });
      const result = await explainResponse(stream);
      assert.equal(result.status, 200, body);
      assert.equal(await result.text(), text);
    }
  }
});

test("nested meaningful leaves retain numeric ancestor status and business vetoes", async () => {
  for (const [error, status] of [
    [{ status: 503, error: { message: "fixture failed" } }, 503],
    [{ status: 503, message: JSON.stringify({ error: { message: "fixture failed" } }) }, 503],
    [{ code: 503, response: { error: { message: "fixture failed" } } }, 503],
    [{ status: 503, error: { code: "content-blocked", message: "blocked" } }, 400],
    [{ code: "insufficient_quota", error: { code: "server_error" } }, 200],
    [{ status: 503, error: { code: 401, message: "denied" } }, 200],
  ]) {
    for (const stream of [false, true]) {
      const body = JSON.stringify({ error });
      const source = new Response(stream ? "event: error\ndata: " + body + "\n\n" : body,
        { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
      assert.equal((await explainResponse(source)).status, status, body);
    }
  }
});
