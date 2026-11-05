import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize, runOnce, status } from "./local-checkin.mjs";

for (const scenario of [
  { name: "server confirms a new reward", marker: true, outcome: "claimed", paused: false },
  { name: "no new reward is not reported as claimed", marker: false, outcome: "done", paused: false },
  { name: "missing reward marker pauses local automation", outcome: "failed", paused: true },
  { name: "GitHub HTML pauses without browser fallback", html: true, outcome: "ineligible", paused: true },
]) {
  test("local default hook: " + scenario.name, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-local-integration-"));
    const previousFetch = globalThis.fetch;
    const calls = [];
    try {
      await initialize(home);
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "org", userId: "42" }));
      await fs.writeFile(path.join(home, "github-cookie.txt"), "user_session=offline-test-only");
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        const headers = new Headers(options.headers);
        calls.push(url.origin + url.pathname);
        assert.equal(options.redirect, "manual");
        assert.equal(headers.has("authorization"), false);
        assert.equal(headers.has("new-api-user"), false);
        if (url.origin === "https://github.com") {
          assert.equal(url.pathname, "/login/oauth/authorize");
          assert.equal(headers.get("cookie"), "user_session=offline-test-only");
          if (scenario.html) return new Response("manual consent required", { headers: { "content-type": "text/html" } });
          return new Response(null, { status: 302, headers: { location: "https://agentrouter.org/oauth/github?code=offline-code&state=offline-state" } });
        }
        assert.equal(url.origin, "https://agentrouter.org");
        assert.ok(!String(headers.get("cookie")).includes("offline-test-only"));
        if (url.pathname === "/api/status") {
          assert.equal(headers.has("cookie"), false);
          return Response.json({ success: true, data: { github_oauth: true, github_client_id: "test-client" } });
        }
        if (url.pathname === "/api/oauth/state") {
          assert.equal(headers.has("cookie"), false);
          return Response.json({ success: true, data: "offline-state" }, { headers: { "set-cookie": "session=fresh-site-state; Secure; HttpOnly" } });
        }
        assert.equal(url.pathname, "/api/oauth/github");
        assert.equal(headers.get("cookie"), "session=fresh-site-state");
        return Response.json({ success: true, data: { id: 42, checked_in: scenario.marker } });
      };
      const now = () => 1_800_000_000_000;
      const first = await runOnce(home, { now });
      assert.equal(first.outcome, scenario.outcome);
      const state = await status(home);
      assert.equal(state.paused, scenario.paused);
      const count = calls.length;
      assert.equal(count, scenario.html ? 3 : 4);
      const second = await runOnce(home, { now });
      assert.equal(second.outcome, scenario.paused ? "paused" : "skipped");
      assert.equal(calls.length, count);
      const persisted = await fs.readFile(path.join(home, "state.json"), "utf8");
      assert.doesNotMatch(persisted, /offline-test-only|offline-code|fresh-site-state/);
    } finally {
      globalThis.fetch = previousFetch;
      assert.equal(path.dirname(home), os.tmpdir());
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}

for (const initial of ["claimed", "failed"]) {
  test("resume preserves 24h gate after " + initial, async () => {
    const { resume } = await import("./local-checkin.mjs");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-local-recovery-"));
    try {
      await initialize(home);
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "org", userId: "42" }));
      await fs.writeFile(path.join(home, "github-cookie.txt"), "user_session=offline-only");
      const at = 1_800_000_000_000;
      await runOnce(home, { now: () => at, checkin: async () => ({ outcome: initial }) });
      await resume(home);
      let calls = 0;
      const result = await runOnce(home, { now: () => at + 1000, checkin: async () => { calls++; return { outcome: "claimed" }; } });
      assert.equal(result.outcome, "skipped");
      assert.equal(calls, 0);
      assert.equal((await status(home)).nextAttemptAt, at + 86_400_000);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}

test("local secrets cannot be initialized in a different Git repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-other-repo-"));
  try {
    await fs.mkdir(path.join(root, ".git"));
    await assert.rejects(initialize(path.join(root, "private")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("no automatic stale-lock deletion API is exposed", async () => {
  const module = await import("./local-checkin.mjs");
  assert.equal("unlock" in module, false);
});

test("replacement lock is never deleted by an older owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-lock-owner-"));
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "org", userId: "42" }));
    await fs.writeFile(path.join(home, "github-cookie.txt"), "user_session=offline-only");
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement-owner" });
    await assert.rejects(runOnce(home, { checkin: async () => {
      await fs.writeFile(path.join(home, "run.lock"), replacement);
      return { outcome: "claimed" };
    } }));
    assert.equal(await fs.readFile(path.join(home, "run.lock"), "utf8"), replacement);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("Windows broad cookie ACL is rejected before checkin", { skip: process.platform !== "win32" }, async () => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-acl-denied-"));
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "org", userId: "42" }));
    await fs.writeFile(path.join(home, "github-cookie.txt"), "user_session=offline-only");
    await promisify(execFile)(path.join(process.env.SystemRoot || "C:/Windows", "System32", "icacls.exe"), [path.join(home, "github-cookie.txt"), "/grant", "*S-1-5-11:R"]);
    let called = false;
    await assert.rejects(runOnce(home, { checkin: async () => { called = true; return { outcome: "claimed" }; } }));
    assert.equal(called, false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("watch checks locally and performs only due attempts with a simulated clock", async () => {
  const { watch } = await import("./local-checkin.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-watch-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "org", userId: "42" }));
    await fs.writeFile(path.join(home, "github-cookie.txt"), "user_session=offline-only");
    let time = 1_800_000_000_000;
    Date.now = () => time;
    let requests = 0;
    globalThis.fetch = async () => {
      switch (requests++ % 4) {
        case 0: return Response.json({ success: true, data: { github_oauth: true, github_client_id: "test-client" } });
        case 1: return Response.json({ success: true, data: "test-state" }, { headers: { "set-cookie": "session=fresh; Secure" } });
        case 2: return new Response(null, { status: 302, headers: { location: "https://agentrouter.org/oauth/github?code=test-code&state=test-state" } });
        default: return Response.json({ success: true, data: { id: 42, checked_in: true } });
      }
    };
    const stop = new AbortController();
    const events = [];
    let polls = 0;
    await watch(home, {
      signal: stop.signal,
      report: result => { events.push(result.outcome); if (events.filter(x => x === "claimed").length === 2) stop.abort(); },
      poll: async ms => { assert.equal(ms, 60_000); time += polls++ === 0 ? 60_000 : 86_400_000; },
    });
    assert.deepEqual(events, ["claimed", "skipped", "claimed"]);
    assert.equal(requests, 8);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a parent junction cannot redirect local credential storage into a repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-parent-junction-"));
  try {
    const repository = path.join(root, "repository");
    const alias = path.join(root, "alias");
    await fs.mkdir(repository);
    await fs.mkdir(path.join(repository, ".git"));
    await fs.symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(initialize(path.join(alias, "private")));
    await assert.rejects(fs.access(path.join(repository, "private", "github-cookie.txt")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
