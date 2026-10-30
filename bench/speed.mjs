// Speed experiment: run the same decisions through several execution modes and compare time and answers
// usage: node bench/speed.mjs [--n 10] [--set all|tier]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../core/cev.mjs";
import { warmDecider } from "../core/warm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const N = Number(arg("--n", 10));
// Mix cases from the easy and hard sets
const easy = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const hard = JSON.parse(readFileSync(join(HERE, "cases-hard.json"), "utf8"));
const cases = [...easy.filter((_, i) => i % 6 === 0), ...hard.filter((_, i) => i % 6 === 1)].slice(0, N);
const reqOf = (c) => ({ state: c.state, rules: c.rules, questions: [c.q] });
const right = (c, a) => [c.gold, ...(c.alt ?? [])].some((g) => (g === "escalate" ? a.escalate : !a.escalate && g === a.answer));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETS = {};
SETS.all = [
  { name: "cold: new processes per decision", run: (req) => decide(req, { log: false }) },
  { name: "warm: pre-started processes", warm: { pool: 2 } },
  { name: "warm + Codex luna", warm: { pool: 2, codexModel: "gpt-6-luna" } },
  { name: "warm + Claude Sonnet", warm: { pool: 2, claudeModel: "sonnet" } },
  { name: "warm, Claude only", warm: { pool: 2 }, models: ["claude"] },
];
// Opus 5.5 + gpt-6.1-sol fixed; only the Codex service tier changes
SETS.tier = [
  { name: "warm: Opus + sol (standard)", warm: { pool: 2 } },
  { name: "warm: Opus + sol (priority)", warm: { pool: 2, serviceTier: "priority" } },
];
const SET = arg("--set", "all");
const variants = SETS[SET];

const out = { at: new Date().toISOString(), cases: cases.map((c) => c.id), variants: [] };
for (const v of variants) {
  let decider = null;
  if (v.warm) {
    decider = warmDecider(v.warm);
    await sleep(8000); // warm-up time is not counted as decision time
  }
  const rows = [];
  for (const c of cases) {
    const r = v.run ? await v.run(reqOf(c)) : await decider.decide(reqOf(c), { models: v.models });
    const a = r.answers[c.q.id];
    rows.push({ id: c.id, ms: r.meta.ms, models: r.meta.models, answer: a.answer, escalate: a.escalate, right: right(c, a) });
    console.log(`${v.name.padEnd(28)} ${c.id.padEnd(10)} ${String(r.meta.ms).padStart(6)}ms ${right(c, a) ? "✓" : "✗"} ${a.answer}${a.escalate ? "→human" : ""} ${Object.entries(r.meta.models).map(([m, x]) => `${m}:${x.ms}${x.ok ? "" : "!"}`).join(" ")}`);
  }
  if (decider) console.log(`  codex tier: ${decider.codexTier()}`);
  decider?.close();
  out.variants.push({ name: v.name, rows });
  writeFileSync(join(HERE, "results", SET === "all" ? "speed.json" : `speed-${SET}.json`), JSON.stringify(out, null, 1));
}
