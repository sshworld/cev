// The command gate and the model settings: no model is called
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRequest, claudeConfig } from "../core/cev.mjs";
import { isRisky, gateRequest, passes } from "../core/gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(readFileSync(join(ROOT, "bench/gate-cases.json"), "utf8"));

test("the pattern check flags every labelled dangerous command and no benign one", () => {
  assert.deepEqual(cases.filter((c) => c.kind === "dangerous" && !isRisky(c.command)).map((c) => c.command), []);
  assert.deepEqual(cases.filter((c) => c.kind === "benign" && isRisky(c.command)).map((c) => c.command), []);
  assert.equal(isRisky(undefined), false);
});

test("the gate request is a valid cev request, and only a confident proceed passes", () => {
  checkRequest(gateRequest({ command: "git push", cwd: "/x" }));
  assert.equal(passes({ answer: "proceed", escalate: false }), true);
  assert.equal(passes({ answer: "proceed", escalate: true }), false);
  assert.equal(passes({ answer: "confirm", escalate: false }), false);
  assert.equal(passes({ answer: "abstain", escalate: true }), false);
  assert.equal(passes(null), false);
});

test("model settings: defaults, overrides; a bad effort or a value that could carry CLI arguments is an error", () => {
  assert.deepEqual(claudeConfig({}), { model: "opus", effort: undefined });
  assert.deepEqual(claudeConfig({ CEV_CLAUDE_MODEL: "claude-sonnet-5-5", CEV_CLAUDE_EFFORT: "low" }), { model: "claude-sonnet-5-5", effort: "low" });
  assert.throws(() => claudeConfig({ CEV_CLAUDE_EFFORT: "lo" }), /CEV_CLAUDE_EFFORT/);
  assert.throws(() => claudeConfig({ CEV_CLAUDE_MODEL: "opus --dangerously-skip-permissions" }), /CEV_CLAUDE_MODEL/);
});

// The hook CLI under a throwaway HOME, no daemon (unused port) and no claude on PATH
function hook(input, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "cev-gate-"));
  const r = spawnSync(process.execPath, [join(ROOT, "cli/gate.mjs")], { input: typeof input === "string" ? input : JSON.stringify(input), env: { HOME: home, PATH: join(home, "nobin"), CEV_PORT: "1", ...env }, encoding: "utf8", timeout: 20_000 });
  const log = join(home, ".cev", "gate.jsonl");
  return { status: r.status, out: r.stdout.trim(), log: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}
const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/tmp/x" });

test("hook: harmless commands and other tools pass silently; unreadable input is asked about in enforce mode only", () => {
  for (const input of [bash("git status"), { tool_name: "Write", tool_input: { file_path: "x" } }]) {
    const r = hook(input, { CEV_GATE: "enforce" });
    assert.deepEqual([r.status, r.out, r.log.length], [0, "", 0]);
  }
  const cut = JSON.stringify(bash("git push --force origin main")).slice(0, -10); // JSON cut off mid-way
  for (const input of ["not json", cut, "null", "[]", {}, { tool_input: { command: "git push" } }, { tool_name: 7, tool_input: { command: "git push" } }, { tool_name: "Bash", tool_input: {} }, { tool_name: "Bash", tool_input: { command: ["git", "push"] } }]) {
    assert.equal(JSON.parse(hook(input, { CEV_GATE: "enforce" }).out).hookSpecificOutput.permissionDecision, "ask");
    assert.deepEqual([hook(input).status, hook(input).out], [0, ""]);
  }
});

test("hook: shadow mode logs and never interferes; enforce asks the user when cev can't decide", () => {
  const shadow = hook(bash("git push --force origin main"), { CEV_GATE_BG: "1" }); // the detached copy's own run
  assert.deepEqual([shadow.status, shadow.out], [0, ""]);
  assert.equal(shadow.log[0].pass, false);
  const front = hook(bash("git push --force origin main")); // what the session waits for: nothing
  assert.deepEqual([front.status, front.out], [0, ""]);
  const enforce = hook(bash("git push --force origin main"), { CEV_GATE: "enforce" });
  assert.equal(JSON.parse(enforce.out).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(hook(bash("git push --force origin main"), { CEV_GATE: "off" }).log.length, 0);
});

test("plugin: the hook it registers enforces without any setting, CEV_GATE still overrides, and the manifest carries the release version", async () => {
  const run = (env) => spawnSync(process.execPath, [join(ROOT, "cli/gate.mjs"), "--default", "enforce"], { input: JSON.stringify(bash("git push --force origin main")), env: { HOME: mkdtempSync(join(tmpdir(), "cev-gate-")), PATH: "/nonexistent", CEV_PORT: "1", ...env }, encoding: "utf8", timeout: 20_000 });
  assert.equal(JSON.parse(run({}).stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.deepEqual([run({ CEV_GATE: "off" }).status, run({ CEV_GATE: "off" }).stdout], [0, ""]);
  assert.deepEqual([run({ CEV_GATE: "shadow" }).status, run({ CEV_GATE: "shadow" }).stdout], [0, ""]);
  const manifest = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
  assert.equal(manifest.version, (await import("../core/tool.mjs")).VERSION);
  assert.equal(manifest.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /gate\.mjs" --default enforce$/);
});

test("hook: a mistyped mode is treated as enforce, not as shadow", () => {
  const r = hook(bash("git push --force origin main"), { CEV_GATE: "enforced" });
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "ask");
});

test("hook: enforce asks on hostile input instead of crashing, passing or hanging", () => {
  const ask = (input, env) => JSON.parse(hook(input, { CEV_GATE: "enforce", ...env }).out).hookSpecificOutput.permissionDecision;
  // a harmless prefix, then padding past the limit, then the real command: never judged on the visible part
  assert.equal(ask(bash(`rm -rf node_modules; #${" ".repeat(4100)}\nrm -rf "$HOME/Documents"`)), "ask");
  assert.equal(ask({ ...bash("git push"), tool_input: { command: "git push", description: { toString: null } } }), "ask");
  const t0 = Date.now();
  assert.equal(isRisky("npm ".repeat(50_000)), true);
  assert.ok(Date.now() - t0 < 200, "long input is not pattern-matched");
});

test("hook: a cold CLI that hangs is killed when the hook gives up, and oversized input is asked about", () => {
  const home = mkdtempSync(join(tmpdir(), "cev-gate-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n/bin/sleep 60 &\necho $! > "${home}/pid"\nwait\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const r = spawnSync(process.execPath, [join(ROOT, "cli/gate.mjs")], { input: JSON.stringify(bash("git push")), env: { HOME: home, PATH: bin, CEV_PORT: "1", CEV_GATE: "enforce", CEV_GATE_TIMEOUT_MS: "1500" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
  const pid = Number(readFileSync(join(home, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hanging CLI and the process it started are gone");
  const big = hook(JSON.stringify(bash("git push")).replace("git push", "git push" + " ".repeat(1024 * 1024)), { CEV_GATE: "enforce" });
  assert.equal(JSON.parse(big.out).hookSpecificOutput.permissionDecision, "ask");
});
