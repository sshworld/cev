// Is a decision repeatable? Asks every case several times through the warm pool and reports the cases whose answer
// or escalation changed between runs.
// usage: node bench/stability.mjs [--files cases.json,cases-hard.json] [--runs 3] [--concurrency 2] [--tag name]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { warmDecider } from "../core/warm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const RUNS = Number(arg("--runs", 3));
const N = Number(arg("--concurrency", 2));
const cases = arg("--files", "cases.json,cases-hard.json").split(",").flatMap((f) => JSON.parse(readFileSync(join(HERE, f), "utf8")));
const d = warmDecider({ pool: N, codex: false });
const rows = cases.map((c) => ({ id: c.id, gold: c.gold, runs: [] }));
for (let run = 0; run < RUNS; run++) {
  let next = 0;
  await Promise.all(Array.from({ length: N }, async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      const r = await d.decide({ state: c.state, rules: c.rules, questions: [c.q] }, { models: ["claude"] });
      const a = r.answers[c.q.id];
      rows[i].runs.push({ answer: a.answer, conf: a.conf, escalate: a.escalate, ms: r.meta.models.claude.ms, via: r.meta.models.claude.via });
    }
  }));
}
d.close();
const key = (x) => `${x.escalate ? "escalate" : x.answer}`;
const unstable = rows.filter((r) => new Set(r.runs.map(key)).size > 1);
const flipsAnswer = rows.filter((r) => new Set(r.runs.filter((x) => !x.escalate).map((x) => String(x.answer))).size > 1);
const ms = rows.flatMap((r) => r.runs.map((x) => x.ms)).sort((a, b) => a - b);
const summary = { cases: rows.length, runs: RUNS, sameEveryRun: rows.length - unstable.length, changed: unstable.length, autoAnswerChanged: flipsAnswer.length, msMedian: ms[Math.floor((ms.length - 1) / 2)], msP90: ms[Math.floor(ms.length * 0.9)], cold: rows.flatMap((r) => r.runs).filter((x) => x.via !== "warm").length };
writeFileSync(join(HERE, "results", `stability${arg("--tag") ? "-" + arg("--tag") : ""}.json`), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary));
for (const r of unstable) console.log(`  ${r.id.padEnd(16)} gold=${String(r.gold).padEnd(10)} ${r.runs.map((x) => `${x.escalate ? "ESC" : x.answer}(${x.conf})`).join("  ")}`);
process.exit(0);
