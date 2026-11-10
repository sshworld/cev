// Accuracy and latency through the production warm path (the pool, the schema in the prompt).
// bench/models.mjs asks cold, where the CLI enforces the schema; this is what the daemon actually does.
// usage: node bench/warm.mjs [--files a.json,b.json] [--kinds regex] [--runs n] [--concurrency 2] [--tag name]
// CEV_CLAUDE_EFFORT=default in front reproduces the pre-1.4.0 setting.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { warmDecider } from "../core/warm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const N = Number(arg("--concurrency", 2));
const KINDS = arg("--kinds") ? new RegExp(arg("--kinds"), "i") : null;
const RUNS = Number(arg("--runs", 1));
const cases = arg("--files", "cases.json,cases-hard.json,cases-x-a.json,cases-x-b.json,cases-x-c.json,cases-x-d.json").split(",").flatMap((f) => JSON.parse(readFileSync(join(HERE, f), "utf8"))).filter((c) => !KINDS || KINDS.test(c.kind ?? "")).flatMap((c) => Array.from({ length: RUNS }, () => c));
// Same outcome classes as models.mjs
function outcome(c, answer, escalate) {
  const ok = [c.gold, ...(c.alt ?? [])];
  const shouldEscalate = c.gold === "escalate" || (c.alt ?? []).includes("escalate");
  const right = ok.some((g) => g !== "escalate" && g === answer);
  if (escalate) return c.gold === "escalate" || (shouldEscalate && !right) ? "escalate_ok" : right ? "safe_escalate" : "caught";
  return right ? "auto_right" : "auto_wrong";
}
const d = warmDecider({ pool: N, codex: false });
const rows = [];
let next = 0;
await Promise.all(Array.from({ length: N }, async () => {
  while (next < cases.length) {
    const c = cases[next++];
    const r = await d.decide({ state: c.state, rules: c.rules, questions: [c.q] }, { models: ["claude"] });
    const a = r.answers[c.q.id], m = r.meta.models.claude;
    rows.push({ id: c.id, gold: c.gold, answer: a.answer, conf: a.conf, escalate: a.escalate, outcome: m.ok ? outcome(c, a.answer, a.escalate) : "failed", ms: r.meta.ms ?? m.ms, via: m.via, ...(m.warmError && { warmError: m.warmError.slice(0, 120) }) });
  }
}));
d.close();
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const count = rows.reduce((t, r) => ({ ...t, [r.outcome]: (t[r.outcome] ?? 0) + 1 }), {});
const summary = { n: rows.length, ...count, cold: rows.filter((r) => r.via === "cold").length, msMedian: pct(rows.map((r) => r.ms), 0.5), msP90: pct(rows.map((r) => r.ms), 0.9) };
writeFileSync(join(HERE, "results", `warm${arg("--tag") ? "-" + arg("--tag") : ""}.json`), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary));
for (const r of rows) if (r.outcome === "auto_wrong" || r.outcome === "failed") console.log(`  ${r.outcome} ${r.id} gold=${r.gold} answer=${r.answer} conf=${r.conf}`);
process.exit(0);
