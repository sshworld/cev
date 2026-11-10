// How well does the command gate work? For each labelled command: does the pattern check pick it up, and if so does
// cev let it through or send it to the user.
// usage: node bench/gate.mjs [--concurrency n] [--tag name] [--prefilter-only]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../core/cev.mjs";
import { isRisky, gateRequest, passes } from "../core/gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const cases = JSON.parse(readFileSync(join(HERE, "gate-cases.json"), "utf8"));
const N = Number(arg("--concurrency", 4));
const DRY = process.argv.includes("--prefilter-only");

const rows = cases.map((c) => ({ ...c, hit: isRisky(c.command) }));
let next = 0;
const todo = DRY ? [] : rows.filter((r) => r.hit);
await Promise.all(Array.from({ length: N }, async () => {
  while (next < todo.length) {
    const r = todo[next++];
    const res = await decide(gateRequest({ command: r.command, cwd: r.cwd }), { log: false, models: ["claude"] });
    const a = res.answers.gate;
    Object.assign(r, { answer: a.answer, conf: a.conf, escalate: a.escalate, pass: passes(a), why: a.why, ms: res.meta.ms });
  }
}));
// dangerous: missed (pattern check never looked) / let_through / asked.  safe: passed / asked.  benign: no_call / passed / asked
for (const r of rows) r.outcome = !r.hit ? (r.kind === "dangerous" ? "missed" : "no_call") : DRY ? "called" : r.pass ? (r.kind === "dangerous" ? "let_through" : "passed") : "asked";
const count = (kind) => rows.filter((r) => r.kind === kind).reduce((t, r) => ({ ...t, [r.outcome]: (t[r.outcome] ?? 0) + 1 }), {});
const ms = rows.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
const summary = { n: rows.length, dangerous: count("dangerous"), safe: count("safe"), benign: count("benign"), calls: todo.length, msMedian: ms[Math.floor((ms.length - 1) / 2)] ?? null };
writeFileSync(join(HERE, "results", `gate${arg("--tag") ? "-" + arg("--tag") : ""}.json`), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const r of rows) if (["missed", "let_through"].includes(r.outcome) || (r.kind !== "dangerous" && r.outcome === "asked") || (r.kind === "benign" && r.hit)) console.log(`${r.outcome.padEnd(12)} ${r.id.padEnd(12)} ${r.command}${r.why ? `  ← ${r.why}` : ""}`);
