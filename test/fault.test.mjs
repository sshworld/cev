// Fault tests with fake CLIs: no model is called. Each case runs in a child process with HOME pointed at a temp dir,
// so ~/.cev is never touched, and PATH holding only the fake (or no) claude/codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
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
