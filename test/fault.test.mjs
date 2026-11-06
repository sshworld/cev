// Fault tests with fake CLIs: no model is called. Each case runs in a child process with HOME pointed at a temp dir,
// so ~/.cev is never touched, and PATH holding only the fake (or no) claude/codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQ = { state: "x", questions: [{ id: "a", type: "bool", ask: "?" }] };
const NODE = process.execPath;

// Run `body` as an ES module in a child; it prints one JSON line with its result
function inChild(body, { fakes = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cev-test-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const [name, script] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const src = `import * as cev from ${JSON.stringify(join(ROOT, "core/cev.mjs"))};
import { warmDecider } from ${JSON.stringify(join(ROOT, "core/warm.mjs"))};
const REQ = ${JSON.stringify(REQ)};
const t0 = performance.now();
const out = await (async () => { ${body} })();
console.log(JSON.stringify({ ...out, elapsed: Math.round(performance.now() - t0) }));
process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: { HOME: home, PATH: bin }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, `child crashed:\n${r.stderr}`);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), home };
}

test("cold: a missing CLI is a failed vote, not a crash", () => {
  const r = inChild(`
    const [c, x] = await Promise.all([cev.askClaude(REQ), cev.askCodex(REQ)]);
    return { c, x, decided: (await cev.decide(REQ, { models: ["claude"], log: false })).answers.a };`);
  assert.equal(r.c.ok, false);
  assert.match(r.c.error, /ENOENT/);
  assert.equal(r.x.ok, false);
  assert.deepEqual([r.decided.answer, r.decided.escalate], ["abstain", true]);
});

test("cold Codex removes its schema file", () => {
  const r = inChild(`await cev.askCodex(REQ); return {};`);
  assert.deepEqual(readdirSync(join(r.home, ".cev", "run")).filter((f) => f.startsWith("schema-")), []);
});

test("warm: missing CLIs fail over without crashing the process", () => {
  const r = inChild(`
    const d = warmDecider({ codex: true, pool: 1, timeout: 2000 });
    const res = await d.decide(REQ);
    d.close();
    return { models: res.meta.models, a: res.answers.a };`);
  assert.equal(r.models.claude.ok, false);
  assert.equal(r.models.codex.ok, false);
  assert.equal(r.a.escalate, true);
});

test("warm: a Codex app-server that never answers is cut off by the deadline", () => {
  // Alive but silent: never replies to initialize, so the old timer (started after thread/start) never ran
  const r = inChild(
    `const d = warmDecider({ codex: true, pool: 1, timeout: 400, fallback: false });
    const res = await d.decide(REQ, { models: ["codex"] });
    d.close();
    return { codex: res.meta.models.codex };`,
    { fakes: { codex: "exec /bin/sleep 30", claude: "exec /bin/sleep 30" } },
  );
  assert.equal(r.codex.ok, false);
  assert.match(r.codex.error, /timeout/);
  assert.ok(r.elapsed < 3000, `took ${r.elapsed}ms`);
});

test("warm: a Claude answer out of range is rejected and escalates", () => {
  // Fake stream-json Claude: reads one prompt line, replies with p_yes 2
  const reply = JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ a: { p_yes: 2, abstain: false, evidence: "", missing: "" } }) });
  const r = inChild(
    `const d = warmDecider({ codex: false, pool: 1, timeout: 3000, fallback: false });
    const res = await d.decide(REQ);
    d.close();
    return { claude: res.meta.models.claude, a: res.answers.a };`,
    { fakes: { claude: `read line; echo '${reply}'` } },
  );
  assert.equal(r.claude.ok, false);
  assert.equal(r.a.escalate, true);
});

test("warm: Codex text without turn/completed is not a success", () => {
  // Fake app-server: answers the handshake, streams a confident answer, then never completes the turn
  const server = `
    import { createInterface } from "node:readline";
    const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    createInterface({ input: process.stdin }).on("line", (l) => {
      const m = JSON.parse(l);
      if (m.method === "initialize") out({ id: m.id, result: {} });
      if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: "t" + m.id } } });
      if (m.method === "turn/start") {
        out({ id: m.id, result: {} });
        out({ method: "item/completed", params: { threadId: m.params.threadId, item: { type: "agentMessage", text: JSON.stringify({ a: { p_yes: 0.99, abstain: false, evidence: "", missing: "" } }) } } });
      }
    });`;
  const r = inChild(
    `const d = warmDecider({ codex: true, pool: 1, timeout: 500, fallback: false });
    const res = await d.decide(REQ, { models: ["codex"] });
    d.close();
    return { codex: res.meta.models.codex, a: res.answers.a };`,
    { fakes: { codex: `exec ${JSON.stringify(NODE)} --input-type=module -e '${server.replace(/'/g, "'\\''")}'`, claude: "exec /bin/sleep 30" } },
  );
  assert.equal(r.codex.ok, false);
  assert.equal(r.a.escalate, true);
});

test("cold: a CLI that prints an answer but fails doesn't count", () => {
  const ans = JSON.stringify({ a: { p_yes: 0.99, abstain: false, evidence: "", missing: "" } });
  const msg = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ans } });
  const claudeOut = JSON.stringify({ is_error: false, structured_output: JSON.parse(ans), result: ans });
  const r = inChild(`const [c, x] = await Promise.all([cev.askClaude(REQ), cev.askCodex(REQ)]); return { c, x };`, {
    fakes: { codex: `echo '${msg}'; echo '{"type":"turn.failed"}'; exit 1`, claude: `echo '${claudeOut}'; exit 1` },
  });
  assert.equal(r.c.ok, false);
  assert.equal(r.x.ok, false);
});

test("Claude-only use never creates the Codex home, and the log is private", () => {
  const r = inChild(`cev.prepare(); cev.appendLog({ t: 1 }); return {};`);
  assert.equal(existsSync(join(r.home, ".cev", "codex-home")), false);
  assert.equal(statSync(join(r.home, ".cev")).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.home, ".cev", "log.jsonl")).mode & 0o777, 0o600);
});

// ── Daemon over HTTP, with no CLIs on PATH ──
test("daemon: survives junk, enforces limits and the MCP session lifecycle", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cev-test-"));
  mkdirSync(join(home, "bin"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const d = spawn(NODE, [join(ROOT, "core/daemon.mjs")], { env: { HOME: home, PATH: join(home, "bin"), CEV_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => d.kill());
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && !(await fetch(`${B}/health`).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100));

  // A request target new URL() can't parse used to crash the process
  await new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => s.end("GET //[ HTTP/1.1\r\nHost: x\r\n\r\n"));
    s.on("close", resolve).on("error", resolve).resume();
  });
  assert.equal((await fetch(`${B}/health`)).status, 200);

  const big = JSON.stringify({ state: "가".repeat(400_000), questions: [{ id: "a", type: "bool", ask: "?" }] }); // ~1.2MB UTF-8, 400k chars
  assert.equal((await fetch(`${B}/decide`, { method: "POST", body: big })).status, 413);
  assert.equal((await fetch(`${B}/decide`, { method: "POST", body: '{"state":"x","questions":[{"id":"a","type":"bool","ask":"?","risk":"HIGH"}]}' })).status, 400);

  const post = (body, headers = {}) => fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid })).status, 202);
  assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" })).status, 400);
  assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid })).status, 200);
  assert.equal((await fetch(`${B}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } })).status, 200);
  assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": sid })).status, 404);

  // No CLI installed: the decision escalates instead of crashing the daemon
  const r = await (await fetch(`${B}/decide`, { method: "POST", body: JSON.stringify(REQ) })).json();
  assert.equal(r.answers.a.escalate, true);
  assert.equal((await fetch(`${B}/health`)).status, 200);
});

test("cli: usage errors exit 2, a daemon refusal exits 1 without a cold retry", () => {
  const home = mkdtempSync(join(tmpdir(), "cev-test-"));
  const cli = join(ROOT, "cli/cev.mjs");
  const run = (args, input) => spawnSync(NODE, [cli, ...args], { input, env: { HOME: home, PATH: "/nonexistent", CEV_PORT: "1" }, encoding: "utf8" });
  assert.equal(run(["decide", "-", "--only"], "{}").status, 2);
  assert.equal(run(["decide", "-", "--bogus"], "{}").status, 2);
  assert.equal(run(["decide", "-"], "not json").status, 2);
  // No daemon on port 1: cold path, which now validates too
  const bad = run(["decide", "-"], JSON.stringify({ state: "x", questions: [{ id: "a", type: "bool", ask: "?", risk: "HIGH" }] }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /risk/);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
});
