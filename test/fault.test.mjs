// Fault tests with fake CLIs: no model is called. Each case runs in a child process with HOME pointed at a temp dir,
// so ~/.cev is never touched, and PATH holding only the fake (or no) claude/codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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
  // No CLI at all: the decision escalates. That is exit 0 by default and exit 3 when the script needs an answer.
  assert.equal(run(["decide", "-"], JSON.stringify(REQ)).status, 0);
  const need = run(["decide", "-", "--require-answer"], JSON.stringify(REQ));
  assert.equal(need.status, 3);
  assert.equal(JSON.parse(need.stdout).answers.a.escalate, true);
  assert.equal(run(["decide", "-", "--deadline-ms", "soon"], JSON.stringify(REQ)).status, 2);
  // The deadline covers starting the daemon; past it every question escalates (exit 0, or 3 when an answer is required)
  const t0 = Date.now();
  const lateRun = run(["decide", "-", "--deadline-ms", "50", "--require-answer"], JSON.stringify(REQ));
  assert.equal(lateRun.status, 3);
  assert.equal(JSON.parse(lateRun.stdout).answers.a.escalate, true);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(run(["decide", "-", "--deadline-ms", "50"], JSON.stringify({ state: "x", questions: [] })).status, 1);
});

// A fake warm Claude: reports its model at start, counts each decision it is asked for, answers a confident yes
const WARM_CLAUDE = (after = `echo '{"type":"result","is_error":false,"result":"{\\"a\\":{\\"p_yes\\":0.99,\\"abstain\\":false,\\"evidence\\":\\"\\",\\"missing\\":\\"\\"}}","modelUsage":{"fake-model-1":{"inputTokens":1,"outputTokens":1}}}'`) =>
  `echo '{"type":"system","subtype":"init","model":"fake-model-1"}'\nread line\necho d >> "$HOME/decided"\n${after}`;
async function daemonWith(t, claude, env = {}, home = mkdtempSync(join(tmpdir(), "cev-test-"))) {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "claude"), `#!/bin/sh\n${claude}\n`);
  chmodSync(join(home, "bin", "claude"), 0o755);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const d = spawn(NODE, [join(ROOT, "core/daemon.mjs")], { env: { HOME: home, PATH: `${join(home, "bin")}:/bin:/usr/bin`, CEV_PORT: String(port), CEV_POOL: "1", ...env }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => d.kill());
  const B = `http://127.0.0.1:${port}`;
  const health = () => fetch(`${B}/health`).then((r) => r.json()).catch(() => null);
  for (let i = 0; i < 80 && (await health())?.model !== "fake-model-1"; i++) await new Promise((r) => setTimeout(r, 100));
  const decide = (state, headers = {}) => fetch(`${B}/decide`, { method: "POST", headers, body: JSON.stringify({ ...REQ, state }) }).then((r) => r.json());
  const decided = () => (existsSync(join(home, "decided")) ? readFileSync(join(home, "decided"), "utf8").split("\n").filter(Boolean).length : 0);
  return { home, d, health, decide, decided };
}

test("daemon: an identical request is replayed, concurrent ones share one call, and the store survives a restart", async (t) => {
  const a = await daemonWith(t, WARM_CLAUDE());
  assert.equal((await a.health()).model, "fake-model-1");
  const first = await a.decide("x");
  assert.deepEqual([first.answers.a.answer, first.answers.a.escalate, first.meta.replay], [true, false, undefined]);
  const again = await a.decide("x");
  assert.deepEqual([again.answers.a.answer, !!again.meta.replay, a.decided()], [true, true, 1]);
  assert.equal((await a.decide("y")).meta.replay, undefined);
  assert.equal(a.decided(), 2);
  const pair = await Promise.all([a.decide("z"), a.decide("z")]);
  assert.equal(a.decided(), 3, "two identical requests at once made one model call");
  assert.deepEqual(pair.map((r) => r.answers.a.answer), [true, true]);
  assert.equal((await a.health()).replayed, 1);
  a.d.kill();
  await new Promise((r) => a.d.on("exit", r));
  const b = await daemonWith(t, WARM_CLAUDE(), {}, a.home);
  assert.equal(!!(await b.decide("x")).meta.replay, true);
  assert.equal(b.decided(), 3);
  const off = await daemonWith(t, WARM_CLAUDE(), { CEV_REPLAY: "0" });
  await off.decide("x");
  assert.equal((await off.decide("x")).meta.replay, undefined);
});

test("daemon: a deadline bounds the queue and the model call, escalates, and a fault is never stored for replay", async (t) => {
  const a = await daemonWith(t, WARM_CLAUDE("/bin/sleep 30 &\nwait"), { CEV_CONCURRENCY: "1" } /* the launcher leaves a child holding its pipes */);
  const t0 = Date.now();
  const r = await a.decide("x", { "x-cev-deadline-ms": "400" });
  assert.ok(Date.now() - t0 < 3000, "answered near the deadline, with no cold retry");
  assert.deepEqual([r.answers.a.answer, r.answers.a.escalate], ["abstain", true]);
  assert.equal((await a.health()).replay, 0);
  // the single slot is held by a request with no deadline: one with a deadline leaves the queue on time
  a.decide("held").catch(() => {});
  await new Promise((res) => setTimeout(res, 200));
  const t1 = Date.now();
  const q = await a.decide("queued", { "x-cev-deadline-ms": "300" });
  assert.ok(Date.now() - t1 < 2000);
  assert.deepEqual([q.answers.a.escalate, q.meta.error], [true, "deadline passed while queued"]);
  assert.equal((await a.health()).queued, 0, "the withdrawn request left the queue");
  // a follower of an identical request already under way keeps its own deadline
  const t2 = Date.now();
  const f = await a.decide("held", { "x-cev-deadline-ms": "300" });
  assert.ok(Date.now() - t2 < 2000);
  assert.equal(f.answers.a.escalate, true);
});

// Fake app-server that completes the turn with the given status (or none) after a confident answer
const appServer = (status) => `
    import { createInterface } from "node:readline";
    const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    createInterface({ input: process.stdin }).on("line", (l) => {
      const m = JSON.parse(l);
      if (m.method === "initialize") out({ id: m.id, result: {} });
      if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: "t" + m.id } } });
      if (m.method === "turn/start") {
        const threadId = m.params.threadId;
        out({ id: m.id, result: { turn: { id: "u1" } } });
        out({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: JSON.stringify({ a: { p_yes: 0.99, abstain: false, evidence: "", missing: "" } }) } } });
        out({ method: "turn/completed", params: { threadId, turn: ${JSON.stringify(status === undefined ? { id: "u1" } : { id: "u1", status })} } });
      }
    });`;
const viaFake = (src) => `exec ${JSON.stringify(NODE)} --input-type=module -e '${src.replace(/'/g, "'\\''")}'`;

test("warm: only an explicit completed status counts", () => {
  for (const [status, ok] of [["completed", true], ["failed", false], ["interrupted", false], [undefined, false]]) {
    const r = inChild(
      `const d = warmDecider({ codex: true, pool: 1, timeout: 2000, fallback: false });
      const res = await d.decide(REQ, { models: ["codex"] });
      d.close();
      return { codex: res.meta.models.codex };`,
      { fakes: { codex: viaFake(appServer(status)), claude: "exec /bin/sleep 30" } },
    );
    assert.equal(r.codex.ok, ok, String(status));
  }
});

test("warm: a Claude child that lingers after answering is killed on close", () => {
  const reply = JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ a: { p_yes: 0.9, abstain: false, evidence: "", missing: "" } }) });
  // Answers, then ignores stdin EOF and stays alive; its pid goes to a file so the test can check it
  const r = inChild(
    `const d = warmDecider({ codex: false, pool: 1, timeout: 3000, fallback: false });
    const res = await d.decide(REQ);
    d.close();
    await new Promise((r) => setTimeout(r, 300));
    const { readFileSync } = await import("node:fs");
    const pids = readFileSync(process.env.HOME + "/pids", "utf8").trim().split("\\n").map(Number);
    const alive = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    return { ok: res.meta.models.claude.ok, alive };`,
    { fakes: { claude: `echo $$ >> "$HOME/pids"; read line; echo '${reply}'; exec /bin/sleep 30` } },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.alive, []);
});
