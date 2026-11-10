// Which Claude model does a cev decision need? Runs every case on each arm (model[:effort]) with lean Claude alone,
// then simulates cascades (cheap arm first, next arm only when the cheap one escalates).
// usage: node bench/models.mjs [--arms haiku,sonnet,opus,opus:low,codex] [--files a.json,b.json] [--only id,..] [--concurrency n] [--tag name]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../core/cev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const ARMS = arg("--arms", "haiku,sonnet,opus,opus:low").split(",");
const N = Number(arg("--concurrency", 4));
const TAG = arg("--tag", "");
const OUT = join(HERE, "results", `models${TAG ? "-" + TAG : ""}.json`);
mkdirSync(dirname(OUT), { recursive: true });

let cases = arg("--files", "cases.json,cases-hard.json").split(",").flatMap((f) => JSON.parse(readFileSync(join(HERE, f), "utf8")).map((c) => ({ ...c, set: f.replace(/^cases-?|\.json$/g, "") || "base" })));
if (arg("--only")) cases = cases.filter((c) => arg("--only").split(",").includes(c.id));

// Same outcome classes as analyze.mjs
function outcome(c, answer, escalate) {
  const ok = [c.gold, ...(c.alt ?? [])];
  const shouldEscalate = c.gold === "escalate" || (c.alt ?? []).includes("escalate");
  const right = ok.some((g) => g !== "escalate" && g === answer);
  if (escalate) return c.gold === "escalate" || (shouldEscalate && !right) ? "escalate_ok" : right ? "safe_escalate" : "caught";
  return right ? "auto_right" : "auto_wrong";
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function tally(rows) {
  const t = { auto_right: 0, safe_escalate: 0, escalate_ok: 0, caught: 0, auto_wrong: 0 };
  for (const r of rows) t[r.outcome]++;
  return { n: rows.length, ...t, failed: rows.filter((r) => !r.ok).length, msMedian: median(rows.map((r) => r.ms)), tokensIn: sum(rows.map((r) => r.tokensIn)), tokensOut: sum(rows.map((r) => r.tokensOut)) };
}

async function runArm(arm) {
  const [model, effort] = arm.split(":");
  const rows = new Array(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: N }, async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      // "codex" is an arm too (the other lab's model), used to cross-check the labels
      const who = model === "codex" ? "codex" : "claude";
      const r = await decide({ state: c.state, rules: c.rules, questions: [c.q] }, { log: false, models: [who], ...(who === "claude" ? { claude: { model, effort } } : effort ? { codex: { effort } } : {}) });
      const a = r.answers[c.q.id];
      const m = r.meta.models[who];
      rows[i] = { id: c.id, set: c.set, risk: c.q.risk ?? "medium", type: c.q.type, answer: a.answer, conf: a.conf, escalate: a.escalate, ok: m.ok, ms: m.ms, tokensIn: m.tokensIn, tokensOut: m.tokensOut, outcome: outcome(c, a.answer, a.escalate), ...(m.error && { error: m.error }) };
    }
  }));
  return rows;
}

const results = { at: new Date().toISOString(), arms: {}, summary: {}, cascades: {} };
for (const arm of ARMS) {
  results.arms[arm] = await runArm(arm);
  results.summary[arm] = tally(results.arms[arm]);
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(arm.padEnd(10), JSON.stringify(results.summary[arm]));
}
// Cascade a>b: keep a's answer unless it escalated, then ask b. Latency and tokens add up for the cases that fall through.
for (const a of ARMS) for (const b of ARMS) {
  if (a === b) continue;
  const rows = results.arms[a].map((ra, i) => {
    if (!ra.escalate) return ra;
    const rb = results.arms[b][i];
    return { ...rb, ms: ra.ms + rb.ms, tokensIn: ra.tokensIn + rb.tokensIn, tokensOut: ra.tokensOut + rb.tokensOut, ok: rb.ok };
  });
  results.cascades[`${a}>${b}`] = { ...tally(rows), fellThrough: results.arms[a].filter((r) => r.escalate).length };
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
for (const [k, v] of Object.entries(results.cascades)) console.log(k.padEnd(18), JSON.stringify(v));
