#!/usr/bin/env node
// Claude Code PreToolUse hook: reads the hook JSON on stdin, and for a shell command that can be hard to undo asks
// cev whether it should run without the user confirming.
// CEV_GATE=shadow (default): return at once; a detached copy decides and logs to ~/.cev/gate.jsonl.
// CEV_GATE=enforce: when cev doesn't clearly say "proceed", return permissionDecision "ask" so the user confirms.
// CEV_GATE=off: do nothing.
// It never returns "allow" or "deny": passing means staying silent, so the normal permission flow still applies.
import { appendFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { decide, HOME, ensureHome } from "../core/cev.mjs";
import { isRisky, gateRequest, passes, MAX_COMMAND } from "../core/gate.mjs";
import { BASE, ensureDaemon } from "../core/client.mjs";

// A mistyped mode must not quietly become "only record": someone who wrote "enforced" believes commands are checked
// CEV_GATE wins; without it the mode is what the hook was registered with (`--default enforce` in the plugin), else shadow
const dflt = process.argv.indexOf("--default");
let MODE = process.env.CEV_GATE || (dflt > 0 ? String(process.argv[dflt + 1]) : "shadow");
if (!["shadow", "enforce", "off"].includes(MODE)) {
  console.error(`cev gate: CEV_GATE must be shadow, enforce or off (got "${MODE.slice(0, 40)}"); using enforce`);
  MODE = "enforce";
}
const TIMEOUT = Number(process.env.CEV_GATE_TIMEOUT_MS) > 0 ? Number(process.env.CEV_GATE_TIMEOUT_MS) : 30_000;
if (MODE === "off") process.exit(0);

// Written synchronously: the script exits right after, and a pipe write that is still queued would be lost
const ask = (reason) => writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason.slice(0, 300) } }) + "\n");

// Hook input is untrusted: read at most 1 MB and wait at most 5s for it. Input that is cut off can't be judged,
// so in enforce mode the user is asked; otherwise the hook stays out of the way.
const MAX_INPUT = 1024 * 1024;
const input = await new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  const done = (v) => (clearTimeout(timer), resolve(v));
  const timer = setTimeout(() => done(null), 5000);
  process.stdin.on("data", (c) => ((size += c.length) > MAX_INPUT ? done(null) : chunks.push(c)));
  process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  process.stdin.on("error", () => done(null));
});
if (input === null) {
  if (MODE === "enforce") ask("cev gate could not read the command (input too large or incomplete)");
  process.exit(0);
}
// In enforce mode anything that can't be read as "this tool, this command" is asked about, never waved through
const unreadable = (why) => {
  if (MODE === "enforce") ask(`cev gate could not read the command (${why})`);
  process.exit(0);
};
let hook;
try {
  hook = JSON.parse(input);
} catch {
  unreadable("input is not JSON");
}
if (hook === null || typeof hook !== "object" || Array.isArray(hook)) unreadable("input is not a hook object");
if (typeof hook.tool_name !== "string") unreadable("no tool name");
if (hook.tool_name !== "Bash") process.exit(0); // other tools are not this gate's business
const command = hook.tool_input?.command;
if (typeof command !== "string") unreadable("no command");
if (!isRisky(command)) process.exit(0);

// Shadow mode must not slow the command down: hand the decision to a detached copy of this script and return now
if (MODE !== "enforce" && !process.env.CEV_GATE_BG) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CEV_GATE_BG: "1" } });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    // Send only what the decision needs, small enough to fit the pipe buffer, and leave once it has been written.
    // A command past the limit stays past it (one extra character), so the copy still refuses to judge it.
    const small = JSON.stringify({ tool_name: "Bash", cwd: typeof hook.cwd === "string" ? hook.cwd.slice(0, 1000) : "", tool_input: { command: command.slice(0, MAX_COMMAND + 1), description: typeof hook.tool_input.description === "string" ? hook.tool_input.description.slice(0, 400) : undefined } });
    child.unref();
    await new Promise((ok) => {
      child.stdin.end(small, ok);
      setTimeout(ok, 1000);
    });
  } catch {}
  process.exit(0);
}

const t0 = performance.now();
let answer = null;
let error;
// One deadline over everything: finding or starting the daemon, the decision, and the cold fallback
const work = (async () => {
  if (command.length > MAX_COMMAND) throw new Error("command too long to judge");
  const req = gateRequest({ command, description: hook.tool_input.description, cwd: hook.cwd });
  await ensureDaemon().catch(() => {});
  const r = await fetch(`${BASE}/decide`, { method: "POST", body: JSON.stringify(req), signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  // A daemon that answered but refused (busy, bad request) is not asked around: going cold would pile work on a busy machine
  if (r && !r.ok) throw new Error(`daemon answered HTTP ${r.status}`);
  return (r ? await r.json() : await decide(req, { log: false })).answers.gate;
})();
try {
  answer = await Promise.race([work, new Promise((_, no) => setTimeout(() => no(new Error("timed out")), TIMEOUT))]);
} catch (e) {
  error = String(e?.message ?? e).slice(0, 200);
}
work.catch(() => {});
const pass = passes(answer);
try {
  ensureHome();
  appendFileSync(join(HOME, "gate.jsonl"), JSON.stringify({ at: new Date().toISOString(), mode: MODE, command: command.slice(0, MAX_COMMAND), cwd: hook.cwd, pass, answer: answer?.answer ?? null, conf: answer?.conf ?? null, escalate: answer?.escalate ?? null, why: answer?.why, ms: Math.round(performance.now() - t0), ...(error && { error }) }) + "\n", { mode: 0o600 });
} catch {}
if (MODE === "enforce" && !pass) {
  ask(error ? `cev gate could not decide (${error})` : `cev gate: ${answer?.why || answer?.missing || "this command can be hard to undo"}`);
}
process.exit(0);
