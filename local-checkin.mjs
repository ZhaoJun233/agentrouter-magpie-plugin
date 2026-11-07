#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { currentWindowsTrustee, isPrivateWindowsAcl } from "./windows-acl.mjs";

const DAY = 24 * 60 * 60 * 1000;
const REPO = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = new Set(["claimed", "done", "failed", "ineligible"]);
class LocalError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new LocalError(code); };
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};

export function defaultHome() {
  return process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AgentRouterCheckin")
    : path.join(os.homedir(), ".local", "share", "agentrouter-checkin");
}

async function outsideGit(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    try { await fs.lstat(path.join(current, ".git")); fail("UNSAFE_HOME"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === path.dirname(current)) return;
  }
}

async function windowsPermissions(home, initialize) {
  const system = path.join(process.env.SystemRoot || "C:/Windows", "System32");
  const exec = promisify(execFile);
  const options = { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 };
  let temporary;
  try {
    const identity = await exec(path.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], options);
    const sid = identity.stdout.match(/S-1-5-(?:[0-9]+-)*[0-9]+/)?.[0];
    if (!sid) fail("UNSAFE_WINDOWS_PERMISSIONS");
    const icacls = path.join(system, "icacls.exe");
    if (initialize) {
      await exec(icacls, [home, "/grant:r", "*" + sid + ":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/inheritance:r"], options);
    }
    // Native signed Windows utilities only; no execution-policy bypass or scripts.
    // /save exports security descriptors, never file contents or credentials.
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ar-acl-"));
    // A native round-trip resolves aliases such as LA for this exact SID only.
    // Never allow LA globally or infer local identity from a SID suffix.
    await exec(icacls, [temporary, "/grant:r", "*" + sid + ":(OI)(CI)F", "/inheritance:r"], options);
    const saved = path.join(temporary, "permissions.txt");
    await exec(icacls, [temporary, "/save", saved], options);
    const probe = (await fs.readFile(saved, "utf16le")).split(/\r?\n/).find(line => line.startsWith("D:"));
    const currentTrustee = currentWindowsTrustee(probe);
    if (!currentTrustee) fail("UNSAFE_WINDOWS_PERMISSIONS");
    const targets = [home];
    for (const name of ["config.json", "github-cookie.txt", "state.json"]) {
      const file = path.join(home, name);
      try { await fs.lstat(file); targets.push(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const target of targets) {
      await fs.rm(saved, { force: true });
      await exec(icacls, [target, "/save", saved], options);
      const descriptor = (await fs.readFile(saved, "utf16le")).split(/\r?\n/).find(line => line.startsWith("D:"));
      if (!descriptor) fail("UNSAFE_WINDOWS_PERMISSIONS");
      if (!isPrivateWindowsAcl(descriptor, currentTrustee)) fail("UNSAFE_WINDOWS_PERMISSIONS");
    }
  } catch { fail("UNSAFE_WINDOWS_PERMISSIONS"); }
  finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
}

async function homePath(home, create = false) {
  const resolved = path.resolve(home);
  if (inside(REPO, resolved) || resolved === path.parse(resolved).root) fail("UNSAFE_HOME");
  await outsideGit(resolved);
  if (create) await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_HOME");
  const canonical = await fs.realpath(resolved);
  if (inside(await fs.realpath(REPO), canonical)) fail("UNSAFE_HOME");
  await outsideGit(canonical); // Also checks a repository reached through a parent junction.
  if (process.platform === "win32") await windowsPermissions(canonical, create);
  else if (stat.mode & 0o077) fail("UNSAFE_HOME_PERMISSIONS");
  return canonical;
}

async function readLocal(file, optional = false) {
  let info;
  try { info = await fs.lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("UNSAFE_FILE");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) fail("INVALID_FILE");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

function parseJSON(text, code) {
  try { return JSON.parse(text); } catch { fail(code); }
}

async function configuration(home) {
  const config = parseJSON(await readLocal(path.join(home, "config.json")), "INVALID_CONFIG");
  if (!config || config.version !== 1 || !["org", "air"].includes(config.site)
      || typeof config.userId !== "string" || !/^[1-9][0-9]*$/.test(config.userId)
      || Object.keys(config).some(k => !["version", "site", "userId"].includes(k))) fail("INVALID_CONFIG");
  return config;
}

async function credentials(home) {
  const config = await configuration(home);
  const cookie = (await readLocal(path.join(home, "github-cookie.txt"))).trim();
  if (!cookie) fail("NOT_CONFIGURED");
  return { type: "api", metadata: { site: config.site, userId: config.userId, githubCookie: cookie } };
}

async function readState(home) {
  const text = await readLocal(path.join(home, "state.json"), true);
  if (text === undefined) return undefined;
  const s = parseJSON(text, "INVALID_STATE");
  if (!s || s.version !== 1 || typeof s.identity !== "string" || !/^(org|air):[1-9][0-9]*$/.test(s.identity)
      || typeof s.paused !== "boolean" || !Number.isSafeInteger(s.lastAttemptAt) || s.lastAttemptAt < 0
      || !Number.isSafeInteger(s.nextAttemptAt) || s.nextAttemptAt < 0
      || (s.lastOutcome !== null && s.lastOutcome !== "interrupted" && !RESULTS.has(s.lastOutcome))
      || (s.lastOutcome === null ? (s.lastAttemptAt !== 0 || s.nextAttemptAt !== 0)
          : s.nextAttemptAt !== s.lastAttemptAt + DAY)) fail("INVALID_STATE");
  return s;
}

async function writeState(home, state) {
  // Never write the auth object, response body, OAuth code or exception text.
  const temporary = path.join(home, ".state-" + randomUUID() + ".tmp");
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(home, "state.json"));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function locked(home, action) {
  const file = path.join(home, "run.lock");
  let handle;
  try { handle = await fs.open(file, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return { outcome: "busy" }; throw error; }
  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    return await action();
  } finally {
    await handle.close();
    const current = parseJSON(await readLocal(file), "LOCK_CHANGED");
    if (current.token !== token) fail("LOCK_CHANGED");
    await fs.unlink(file);
  }
}

export async function initialize(home = defaultHome()) {
  home = await homePath(home, true);
  for (const [name, text] of [["config.json", JSON.stringify({ version: 1, site: "org", userId: "" }, null, 2) + "\n"], ["github-cookie.txt", ""]]) {
    try { await fs.writeFile(path.join(home, name), text, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; await readLocal(path.join(home, name)); }
  }
  return { initialized: true, home };
}

export async function status(home = defaultHome()) {
  home = await homePath(home);
  let configured = false;
  try { await credentials(home); configured = true; }
  catch (error) { if (!(error instanceof LocalError) || !["NOT_CONFIGURED", "INVALID_CONFIG"].includes(error.code)) throw error; }
  const state = await readState(home);
  return { configured, paused: state?.paused ?? false, nextAttemptAt: state?.nextAttemptAt ?? null, lastOutcome: state?.lastOutcome ?? null };
}

async function defaultCheckin(auth) {
  const { default: plugin } = await import("./index.mjs");
  return (await plugin()).auth.checkin(async () => auth, {});
}

export async function runOnce(home = defaultHome(), { now = Date.now, checkin = defaultCheckin } = {}) {
  home = await homePath(home);
  return locked(home, async () => {
    const auth = await credentials(home);
    const identity = auth.metadata.site + ":" + auth.metadata.userId;
    const state = await readState(home);
    if (state && state.identity !== identity) return { outcome: "paused", reason: "ACCOUNT_CHANGED" };
    if (state?.paused) return { outcome: "paused", reason: "MANUAL_RECOVERY_REQUIRED" };
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + DAY)) fail("INVALID_CLOCK");
    if (state && at < state.nextAttemptAt) return { outcome: "skipped", reason: "NOT_DUE" };
    // Persist a fail-closed reservation BEFORE any network side effect.
    const pending = { version: 1, identity, lastAttemptAt: at, nextAttemptAt: at + DAY, paused: true, lastOutcome: "interrupted" };
    await writeState(home, pending);
    let outcome = "failed";
    try {
      const result = await checkin(auth);
      if (RESULTS.has(result?.outcome)) outcome = result.outcome;
    } catch { /* Intentionally do not log exception text: it may contain secrets. */ }
    await writeState(home, { ...pending, paused: outcome !== "claimed" && outcome !== "done", lastOutcome: outcome });
    return { outcome };
  });
}

export async function resume(home = defaultHome()) {
  home = await homePath(home);
  return locked(home, async () => {
    const config = await configuration(home);
    const previous = await readState(home); // Corrupt state must not be silently discarded.
    const state = previous || { version: 1, lastAttemptAt: 0, nextAttemptAt: 0, lastOutcome: null };
    await writeState(home, { ...state, identity: config.site + ":" + config.userId, paused: false });
    return { resumed: true, networkRequested: false };
  });
}

export async function watch(home = defaultHome(), { signal, report = r => console.log(JSON.stringify(r)), poll = ms => sleep(ms, undefined, { signal }) } = {}) {
  let previous;
  while (!signal?.aborted) {
    const result = await runOnce(home);
    const text = JSON.stringify(result);
    if (text !== previous) report(result);
    previous = text;
    if (["failed", "ineligible", "paused", "busy"].includes(result.outcome)) return result;
    try { await poll(60_000); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  return { stopped: true };
}

const HELP =   "Local HTTP only. No browser automation or browser-session extraction.\n" +
  "Usage: node local-checkin.mjs <init|status|run|watch|resume> [--home ABSOLUTE_DIRECTORY]\n" +
  "run/watch: at most one attempt per 24h; failure pauses until explicit resume.\n" +
  "resume: after manual recovery only; keeps the 24h cooldown and makes no request.\n" +
  "Never pass a Cookie on the command line or in chat. Data stays in your local user directory.";

async function main(argv) {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(command)) { console.log(HELP); return; }
  if (rest.length && (rest.length !== 2 || rest[0] !== "--home" || !path.isAbsolute(rest[1]))) fail("INVALID_ARGUMENTS");
  const home = rest[1] || defaultHome();
  const actions = { init: initialize, status, run: runOnce, resume };
  let result;
  if (command === "watch") {
    const stop = new AbortController();
    const onStop = () => stop.abort();
    process.once("SIGINT", onStop);
    process.once("SIGTERM", onStop);
    try { result = await watch(home, { signal: stop.signal }); }
    finally { process.off("SIGINT", onStop); process.off("SIGTERM", onStop); }
  } else {
    if (!Object.hasOwn(actions, command)) fail("INVALID_ARGUMENTS");
    result = await actions[command](home);
    console.log(JSON.stringify(result));
  }
  if (["failed", "ineligible", "paused", "busy"].includes(result?.outcome)) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ error: error instanceof LocalError ? error.code : "LOCAL_OPERATION_FAILED" }));
    process.exitCode = 1;
  });
}
