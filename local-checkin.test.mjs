import test, {after, before} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, readFile, rm, symlink, writeFile, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const COOKIE = "user_session=offline-fixture-secret; __Host-user_session_same_site=offline-only";
const SECRET = "upstream-private-message-offline-fixture";
const moduleUrl = new URL("./local-checkin.mjs", import.meta.url);
const repository = dirname(fileURLToPath(import.meta.url));
let initialize, runOnce, resume, status;
let originalFetch;
let networkCalls = 0;

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Offline local check-in tests forbid network access");
  };
  ({initialize, runOnce, resume, status} = await import(moduleUrl.href));
});

after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, "no test may perform a real network request");
});

async function fixture(t, configured = true) {
  const root = await mkdtemp(join(tmpdir(), "local-checkin-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = join(root, "home");
  await initialize(home);
  if (configured) {
    await writeFile(join(home, "config.json"), JSON.stringify({version: 1, site: "org", userId: "42"}));
    await writeFile(join(home, "github-cookie.txt"), COOKIE);
  }
  return {root, home};
}

async function json(home, name = "state.json") {
  return JSON.parse(await readFile(join(home, name), "utf8"));
}

function assertSanitized(value) {
  const serialized = value instanceof Error ? value.message : JSON.stringify(value);
  for (const secret of [COOKIE, SECRET, "offline-fixture-secret", "__Host-user_session_same_site"]) {
    assert.ok(!String(serialized).includes(secret), "public data must not contain credentials or upstream text");
  }
}

function assertResult(value, outcome) {
  assert.equal(value.outcome, outcome);
  assert.ok(Object.keys(value).every(key => ["outcome", "reason"].includes(key)));
  if (value.reason !== undefined) assert.equal(typeof value.reason, "string");
  assertSanitized(value);
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), {code: "ENOENT"});
}

// Validation may reject or return a safe failure; it must never reach checkin.
async function assertClosed(home) {
  let calls = 0;
  let result;
  let failure;
  try {
    result = await runOnce(home, {now: () => NOW, checkin: async () => {
      calls++;
      return {outcome: "claimed", message: SECRET};
    }});
  } catch (error) {
    failure = error;
  }
  assert.equal(calls, 0, "invalid local input must fail before checkin");
  if (failure) assertSanitized(failure);
  else {
    assert.ok(["failed", "paused"].includes(result?.outcome), "invalid input must not look successful");
    assertResult(result, result.outcome);
  }
}

async function trySymlink(t, target, path, directory = false) {
  try {
    await symlink(target, path, directory ? "dir" : "file");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) {
      t.skip("This platform does not permit creating symbolic links");
      return false;
    }
    throw error;
  }
}

test("initialize creates empty private templates and never overwrites existing files", async t => {
  const {home} = await fixture(t, false);
  assert.deepEqual(await json(home, "config.json"), {version: 1, site: "org", userId: ""});
  assert.equal(await readFile(join(home, "github-cookie.txt"), "utf8"), "");
  const config = JSON.stringify({version: 1, site: "air", userId: "73"});
  const state = JSON.stringify({keep: "existing-state"});
  await writeFile(join(home, "config.json"), config);
  await writeFile(join(home, "github-cookie.txt"), COOKIE);
  await writeFile(join(home, "state.json"), state);
  await initialize(home);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
  assert.equal(await readFile(join(home, "github-cookie.txt"), "utf8"), COOKIE);
  assert.equal(await readFile(join(home, "state.json"), "utf8"), state);
});

test("initialize refuses a home inside the repository before creating it", async () => {
  const home = join(repository, ".local-checkin-must-not-create-" + process.pid);
  await assertAbsent(home);
  await assert.rejects(async () => initialize(home));
  await assertAbsent(home);
});

test("empty initialization and missing credentials never call checkin", async t => {
  const {home} = await fixture(t, false);
  await assertClosed(home);
  await writeFile(join(home, "config.json"), JSON.stringify({version: 1, site: "org", userId: "42"}));
  await assertClosed(home);
  await writeFile(join(home, "github-cookie.txt"), "  \n\t");
  await assertClosed(home);
});

for (const [label, patch] of [
  ["missing userId", {userId: undefined}], ["empty userId", {userId: ""}],
  ["numeric userId", {userId: 42}], ["zero userId", {userId: "0"}],
  ["negative userId", {userId: "-42"}], ["fractional userId", {userId: "4.2"}],
  ["non-numeric userId", {userId: "someone"}], ["whitespace userId", {userId: " 42 "}],
  ["wrong site", {site: "other"}], ["wrong version", {version: 2}],
]) {
  test("invalid configuration fails closed: " + label, async t => {
    const {home} = await fixture(t);
    await writeFile(join(home, "config.json"), JSON.stringify({version: 1, site: "org", userId: "42", ...patch}));
    await assertClosed(home);
    await assertAbsent(join(home, "run.lock"));
  });
}

for (const name of ["config.json", "github-cookie.txt"]) {
  test("missing " + name + " fails closed", async t => {
    const {home} = await fixture(t);
    await rm(join(home, name));
    await assertClosed(home);
  });
}

test("malformed configuration fails closed", async t => {
  const {home} = await fixture(t);
  await writeFile(join(home, "config.json"), "{" + SECRET);
  await assertClosed(home);
});

for (const site of ["org", "air"]) {
  for (const outcome of ["claimed", "done"]) {
    test(site + ": " + outcome + " persists an attempt before callback and exposes no grant message", async t => {
      const {home} = await fixture(t);
      await writeFile(join(home, "config.json"), JSON.stringify({version: 1, site, userId: "42"}));
      let calls = 0;
      const result = await runOnce(home, {now: () => NOW, checkin: async auth => {
        calls++;
        assert.deepEqual(auth, {type: "api", metadata: {site, userId: "42", githubCookie: COOKIE}});
        const state = await json(home);
        assert.equal(state.version, 1);
        assert.equal(state.identity, site + ":42");
        assert.equal(state.lastAttemptAt, NOW);
        assert.equal(state.nextAttemptAt, NOW + DAY);
        assert.ok((await lstat(join(home, "run.lock"))).isFile());
        return {outcome, message: "Granted 999 credits " + SECRET + " " + COOKIE};
      }});
      assert.equal(calls, 1);
      assertResult(result, outcome);
      const state = await json(home);
      assert.equal(state.paused, false);
      assert.equal(state.lastOutcome, outcome);
      assertSanitized(state);
      await assertAbsent(join(home, "run.lock"));
    });
  }
}

test("24-hour gate survives a fresh process and opens exactly at the boundary", async t => {
  const {home} = await fixture(t);
  let calls = 0;
  const checkin = async () => { calls++; return {outcome: "claimed", message: SECRET}; };
  assertResult(await runOnce(home, {now: () => NOW, checkin}), "claimed");
  const recorded = await readFile(join(home, "state.json"), "utf8");
  assertResult(await runOnce(home, {now: () => NOW + DAY - 1, checkin}), "skipped");
  assert.equal(calls, 1);
  assert.equal(await readFile(join(home, "state.json"), "utf8"), recorded);
  const script = [
    'globalThis.fetch = async () => { throw new Error("network forbidden"); };',
    'const {runOnce} = await import(' + JSON.stringify(moduleUrl.href) + ');',
    'let calls = 0;',
    'const result = await runOnce(' + JSON.stringify(home) + ', {now: () => ' + (NOW + DAY - 1) + ', checkin: async () => { calls++; return {outcome: "claimed"}; }});',
    'console.log(JSON.stringify({result, calls}));',
  ].join("\n");
  const fresh = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {encoding: "utf8", timeout: 10_000}));
  assertResult(fresh.result, "skipped");
  assert.equal(fresh.calls, 0);
  assertResult(await runOnce(home, {now: () => NOW + DAY, checkin}), "claimed");
  assert.equal(calls, 2);
  assert.equal((await json(home)).nextAttemptAt, NOW + 2 * DAY);
});

for (const kind of ["failed", "ineligible", "unknown", "throw"]) {
  test(kind + " pauses future attempts until an explicit network-free resume", async t => {
    const {home} = await fixture(t);
    let calls = 0;
    const checkin = async () => {
      calls++;
      if (kind === "throw") throw new Error(SECRET + " " + COOKIE);
      return {outcome: kind, message: SECRET + " " + COOKIE};
    };
    const outcome = kind === "ineligible" ? "ineligible" : "failed";
    assertResult(await runOnce(home, {now: () => NOW, checkin}), outcome);
    const state = await json(home);
    assert.equal(state.lastAttemptAt, NOW);
    assert.equal(state.nextAttemptAt, NOW + DAY);
    assert.equal(state.paused, true);
    assert.equal(state.lastOutcome, outcome);
    assertSanitized(state);
    await assertAbsent(join(home, "run.lock"));
    assertResult(await runOnce(home, {now: () => NOW + 10 * DAY, checkin}), "paused");
    assert.equal(calls, 1);
    assertSanitized(await resume(home));
    assert.equal(calls, 1, "resume must not invoke checkin");
    assert.equal((await json(home)).paused, false);
    assert.equal((await json(home)).nextAttemptAt, NOW + DAY);
    assertResult(await runOnce(home, {now: () => NOW + DAY, checkin: async () => {
      calls++;
      return {outcome: "done", message: SECRET};
    }}), "done");
    assert.equal(calls, 2);
    await assertAbsent(join(home, "run.lock"));
  });
}

for (const [label, response] of [
  ["undefined", undefined], ["null", null], ["empty object", {}],
  ["boolean true", true], ["string true outcome", {outcome: "true"}],
  ["private unknown outcome", {outcome: SECRET, message: COOKIE}],
]) {
  test("unknown callback response pauses without leaking: " + label, async t => {
    const {home} = await fixture(t);
    let calls = 0;
    const checkin = async () => { calls++; return response; };
    assertResult(await runOnce(home, {now: () => NOW, checkin}), "failed");
    assertResult(await runOnce(home, {now: () => NOW + 2 * DAY, checkin}), "paused");
    assert.equal(calls, 1);
    const state = await json(home);
    assert.equal(state.paused, true);
    assert.equal(state.lastOutcome, "failed");
    assertSanitized(state);
    await assertAbsent(join(home, "run.lock"));
  });
}

const validState = {version: 1, identity: "org:42", nextAttemptAt: NOW - 1, lastAttemptAt: NOW - DAY - 1, paused: false, lastOutcome: "claimed"};
for (const [label, content] of [
  ["invalid JSON", "{" + SECRET], ["null", "null"], ["array", "[]"], ["empty", "{}"],
  ["wrong version", JSON.stringify({...validState, version: 2})],
  ["string deadline", JSON.stringify({...validState, nextAttemptAt: "0"})],
  ["missing deadline", JSON.stringify({...validState, nextAttemptAt: undefined})],
  ["invalid attempt timestamp", JSON.stringify({...validState, lastAttemptAt: "yesterday"})],
  ["invalid pause flag", JSON.stringify({...validState, paused: "false"})],
  ["unknown last outcome", JSON.stringify({...validState, lastOutcome: SECRET})],
  ["different identity", JSON.stringify({...validState, identity: "org:73"})],
]) {
  test("malformed state fails closed: " + label, async t => {
    const {home} = await fixture(t);
    await writeFile(join(home, "state.json"), content);
    await assertClosed(home);
    await assertAbsent(join(home, "run.lock"));
  });
}

test("status reports only sanitized readiness and gate fields", async t => {
  const {home} = await fixture(t, false);
  const unconfigured = await status(home);
  assert.equal(unconfigured.configured, false);
  assert.ok(Object.keys(unconfigured).every(key => ["configured", "paused", "nextAttemptAt", "lastOutcome"].includes(key)));
  await writeFile(join(home, "config.json"), JSON.stringify({version: 1, site: "org", userId: "42"}));
  await writeFile(join(home, "github-cookie.txt"), COOKIE);
  await runOnce(home, {now: () => NOW, checkin: async () => ({outcome: "failed", message: SECRET + COOKIE})});
  const value = await status(home);
  assert.deepEqual(Object.keys(value).sort(), ["configured", "lastOutcome", "nextAttemptAt", "paused"]);
  assert.deepEqual(value, {configured: true, paused: true, nextAttemptAt: NOW + DAY, lastOutcome: "failed"});
  assertSanitized(value);
});

test("an existing wx lock returns busy without deleting another owner's lock", async t => {
  const {home} = await fixture(t);
  const lock = join(home, "run.lock");
  await writeFile(lock, "other-owner", {flag: "wx"});
  let calls = 0;
  assertResult(await runOnce(home, {now: () => NOW, checkin: async () => { calls++; return {outcome: "claimed"}; }}), "busy");
  assert.equal(calls, 0);
  assert.equal(await readFile(lock, "utf8"), "other-owner");
});

test("overlapping deferred attempts invoke checkin only once", {timeout: 10_000}, async t => {
  const {home} = await fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = runOnce(home, {now: () => NOW, checkin: async () => {
    calls++;
    entered();
    await pending;
    return {outcome: "claimed", message: SECRET};
  }});
  try {
    await Promise.race([started, first.then(() => { throw new Error("first run returned without invoking checkin"); })]);
    assertResult(await runOnce(home, {now: () => NOW, checkin: async () => { calls++; return {outcome: "claimed"}; }}), "busy");
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
  assertResult(await first, "claimed");
  await assertAbsent(join(home, "run.lock"));
});

test("home symlinks are rejected by initialize and runOnce", async t => {
  const {root, home} = await fixture(t);
  const alias = join(root, "linked-home");
  if (!await trySymlink(t, home, alias, true)) return;
  await assert.rejects(async () => initialize(alias));
  await assertClosed(alias);
  assert.equal(await readFile(join(home, "github-cookie.txt"), "utf8"), COOKIE);
});

for (const name of ["config.json", "github-cookie.txt"]) {
  test(name + " symlinks are rejected without touching their targets", async t => {
    const {root, home} = await fixture(t);
    const path = join(home, name);
    const original = await readFile(path, "utf8");
    const target = join(root, "linked-" + name);
    await writeFile(target, original);
    await rm(path);
    if (!await trySymlink(t, target, path)) return;
    await assertClosed(home);
    await assert.rejects(async () => initialize(home));
    assert.equal(await readFile(target, "utf8"), original);
  });
}
