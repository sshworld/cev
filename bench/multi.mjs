// Concurrent-session test: each session opens its own MCP connection and they all fire decisions at once.
// usage: node bench/multi.mjs [--port 7767] [--sessions 6] [--each 2]
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const BASE = `http://127.0.0.1:${arg("--port", 7767)}`;
const SESSIONS = Number(arg("--sessions", 6));
const EACH = Number(arg("--each", 2));
const cases = [...JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")), ...JSON.parse(readFileSync(join(HERE, "cases-hard.json"), "utf8"))];
const right = (c, a) => [c.gold, ...(c.alt ?? [])].some((g) => (g === "escalate" ? a.escalate : !a.escalate && g === a.answer));

async function rpc(sid, msg, client) {
  const r = await fetch(`${BASE}/mcp?client=${client}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid && { "mcp-session-id": sid }) },
    body: JSON.stringify(msg),
  });
  return { sid: r.headers.get("mcp-session-id") ?? sid, status: r.status, body: r.status === 200 ? await r.json() : null };
}

// Memory of the daemon and its child processes (MB)
function memory() {
  const pid = JSON.parse(execSync(`curl -s ${BASE}/health`).toString()).pid;
  const rows = execSync("ps -axo pid=,ppid=,rss=,comm=").toString().trim().split("\n").map((l) => l.trim().split(/\s+/));
  const tree = new Set([String(pid)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of rows) if (tree.has(pp) && !tree.has(p)) tree.add(p), (grew = true);
  }
  const mine = rows.filter(([p]) => tree.has(p));
  return { procs: mine.length, mb: Math.round(mine.reduce((a, [, , rss]) => a + Number(rss), 0) / 1024) };
}

const before = memory();
const t0 = performance.now();
const jobs = Array.from({ length: SESSIONS }, async (_, s) => {
  const client = `session-${s + 1}`;
  const { sid } = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: client }, capabilities: {} } }, client);
  await rpc(sid, { jsonrpc: "2.0", method: "notifications/initialized" }, client);
  return Promise.all(Array.from({ length: EACH }, async (_, k) => {
    const c = cases[(s * EACH + k) * 7 % cases.length];
    const ts = performance.now();
    const r = await rpc(sid, { jsonrpc: "2.0", id: 10 + k, method: "tools/call", params: { name: "cev_decide", arguments: { state: c.state, rules: c.rules, questions: [c.q] } } }, client);
    const out = r.body?.result?.structuredContent;
    const a = out?.answers?.[c.q.id];
    const row = { session: client, id: c.id, wallMs: Math.round(performance.now() - ts), decideMs: out?.ms, answer: a?.answer, escalate: a?.escalate, right: a ? right(c, a) : false, error: r.body?.result?.isError ? r.body.result.content[0].text : undefined };
    console.log(`${client.padEnd(10)} ${c.id.padEnd(10)} wall ${String(row.wallMs).padStart(6)}ms  decide ${String(row.decideMs).padStart(6)}ms  ${row.right ? "✓" : "✗"} ${row.answer}${row.escalate ? "→human" : ""}${row.error ? " " + row.error : ""}`);
    return row;
  }));
});
const rows = (await Promise.all(jobs)).flat();
const totalMs = Math.round(performance.now() - t0);
const after = memory();
const health = await (await fetch(`${BASE}/health`)).json();

const sorted = rows.map((r) => r.wallMs).sort((a, b) => a - b);
const summary = {
  sessions: SESSIONS,
  decisions: rows.length,
  totalMs,
  wallMedianMs: sorted[Math.floor(sorted.length / 2)],
  wallMaxMs: sorted.at(-1),
  decideMedianMs: rows.map((r) => r.decideMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  right: rows.filter((r) => r.right).length,
  memory: { before, after },
  health,
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(join(HERE, "results", "multi.json"), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
