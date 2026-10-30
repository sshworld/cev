// raw.json → summary.json: compute cost, latency and quality metrics
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { combine, groundedIn, promptOf } from "../core/cev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TAG = arg("--tag", "");
const sfx = TAG ? "-" + TAG : "";
const raw = JSON.parse(readFileSync(join(HERE, "results", `raw${sfx}.json`), "utf8"));
const cases = Object.fromEntries(JSON.parse(readFileSync(join(HERE, arg("--cases", "cases.json")), "utf8")).map((c) => [c.id, c]));
const reqOf = (c) => ({ state: c.state, rules: c.rules, questions: [c.q] });

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

// Outcomes: auto_right / escalate_ok (right but escalated) / safe_escalate (should escalate, did) / caught (wrong but escalated) / auto_wrong
function outcome(c, answer, escalate) {
  const ok = [c.gold, ...(c.alt ?? [])];
  const shouldEscalate = c.gold === "escalate" || (c.alt ?? []).includes("escalate");
  const right = ok.some((g) => g !== "escalate" && g === answer);
  if (escalate) return c.gold === "escalate" || (shouldEscalate && !right) ? "escalate_ok" : right ? "safe_escalate" : "caught";
  return right ? "auto_right" : "auto_wrong";
}
const tally = (rows) => {
  const t = { auto_right: 0, safe_escalate: 0, escalate_ok: 0, caught: 0, auto_wrong: 0 };
  for (const r of rows) t[r]++;
  const n = rows.length;
  const auto = t.auto_right + t.auto_wrong;
  return { ...t, n, correct: (t.auto_right + t.escalate_ok) / n, harmful: t.auto_wrong / n, autoRate: auto / n, autoPrecision: auto ? t.auto_right / auto : null, humanRate: (t.safe_escalate + t.escalate_ok + t.caught) / n };
};

// Tokens per character, measured with lean Claude on the 60 request payloads (32,075 chars → 12,775 tokens).
// A stock call can't measure this because hooks inject a variable amount of context. Re-measure if the cases change language or shape.
const TOK_PER_CHAR = 0.4;
const tok = (s) => Math.round(String(s).length * TOK_PER_CHAR);

const rows = raw.cases.map((r) => {
  const c = cases[r.id];
  const qid = c.q.id;
  const req = reqOf(c);
  const cevA = r.cev.answers[qid];
  const votes = r.cev.votes;
  const single = (m) => (votes[m] ? combine(req, [votes[m]])[qid] : { answer: "abstain", escalate: true, conf: 0 });
  const claudeOnly = single("claude");
  const codexOnly = single("codex");
  const baseEsc = r.baseline.answer === "abstain" || !r.baseline.parsed;
  const toolResult = JSON.stringify({ [qid]: { answer: cevA.answer, conf: cevA.conf, agree: cevA.agree, escalate: cevA.escalate, why: cevA.why } });
  const m = r.cev.meta.models;
  return {
    id: r.id,
    domain: c.domain,
    type: c.q.type,
    risk: c.q.risk ?? "medium",
    gold: c.gold,
    base: { answer: r.baseline.answer, parsed: r.baseline.parsed, ms: r.baseline.ms, tokensIn: r.baseline.tokensIn, tokensOut: r.baseline.tokensOut, costUSD: r.baseline.costUSD, outcome: outcome(c, r.baseline.answer, baseEsc) },
    cev: { answer: cevA.answer, conf: cevA.conf, agree: cevA.agree, escalate: cevA.escalate, ms: r.cev.meta.ms, outcome: outcome(c, cevA.answer, cevA.escalate) },
    claude: { answer: claudeOnly.answer, conf: claudeOnly.conf, escalate: claudeOnly.escalate, ok: m.claude.ok && !!votes.claude, ms: m.claude.ms, tokensIn: m.claude.tokensIn, tokensOut: m.claude.tokensOut, outcome: outcome(c, claudeOnly.answer, claudeOnly.escalate), grounded: groundedIn(c.state, votes.claude?.[qid]?.evidence) },
    codex: { answer: codexOnly.answer, conf: codexOnly.conf, escalate: codexOnly.escalate, ok: m.codex.ok && !!votes.codex, ms: m.codex.ms, tokensIn: m.codex.tokensIn, tokensOut: m.codex.tokensOut, outcome: outcome(c, codexOnly.answer, codexOnly.escalate), grounded: groundedIn(c.state, votes.codex?.[qid]?.evidence) },
    // Tokens left in the main conversation: baseline = the agent's whole written judgment; cev = the tool call (request) + compact result
    mainCtx: { base: r.baseline.tokensOut, cevCall: tok(promptOf(req)), cevResult: tok(toolResult) },
  };
});

const pick = (k, f) => rows.map((r) => f(r[k]));
const summary = {
  at: raw.at,
  n: rows.length,
  tokPerChar: TOK_PER_CHAR,
  fixedOverhead: { baseline: raw.calib.tokensIn },
  tokens: {
    baselineIn: median(pick("base", (b) => b.tokensIn)),
    baselineOut: median(pick("base", (b) => b.tokensOut)),
    claudeIn: median(pick("claude", (b) => b.tokensIn)),
    claudeOut: median(pick("claude", (b) => b.tokensOut)),
    codexIn: median(pick("codex", (b) => b.tokensIn)),
    codexOut: median(pick("codex", (b) => b.tokensOut)),
  },
  mainCtx: {
    base: median(rows.map((r) => r.mainCtx.base)),
    cev: median(rows.map((r) => r.mainCtx.cevCall + r.mainCtx.cevResult)),
    cevCall: median(rows.map((r) => r.mainCtx.cevCall)),
    cevResult: median(rows.map((r) => r.mainCtx.cevResult)),
  },
  ms: {
    base: { median: median(pick("base", (b) => b.ms)), p90: p90(pick("base", (b) => b.ms)) },
    cev: { median: median(pick("cev", (b) => b.ms)), p90: p90(pick("cev", (b) => b.ms)) },
    claude: { median: median(pick("claude", (b) => b.ms)), p90: p90(pick("claude", (b) => b.ms)) },
    codex: { median: median(pick("codex", (b) => b.ms)), p90: p90(pick("codex", (b) => b.ms)) },
  },
  costUSD: { baseline: mean(pick("base", (b) => b.costUSD)) },
  quality: {
    base: tally(pick("base", (b) => b.outcome)),
    claude: tally(pick("claude", (b) => b.outcome)),
    codex: tally(pick("codex", (b) => b.outcome)),
    cev: tally(pick("cev", (b) => b.outcome)),
  },
  format: { baselineParsed: mean(pick("base", (b) => (b.parsed ? 1 : 0))), claudeOk: mean(pick("claude", (b) => (b.ok ? 1 : 0))), codexOk: mean(pick("codex", (b) => (b.ok ? 1 : 0))) },
  grounding: {
    claude: mean(rows.filter((r) => r.claude.grounded !== null).map((r) => (r.claude.grounded ? 1 : 0))),
    codex: mean(rows.filter((r) => r.codex.grounded !== null).map((r) => (r.codex.grounded ? 1 : 0))),
  },
  agreeRate: mean(rows.map((r) => (r.cev.agree ? 1 : 0))),
};

// Calibration: actual accuracy per conf bin, over decisions that were not escalated
const bins = [[0, 0.75], [0.75, 0.9], [0.9, 1.01]];
summary.calibration = ["claude", "codex", "cev"].map((k) => ({
  who: k,
  bins: bins.map(([lo, hi]) => {
    const inBin = rows.filter((r) => r.gold !== "escalate" && r[k].answer !== "abstain" && r[k].conf >= lo && r[k].conf < hi);
    const right = inBin.filter((r) => [r.gold, ...(cases[r.id].alt ?? [])].includes(r[k].answer));
    return { lo, hi, n: inBin.length, acc: inBin.length ? right.length / inBin.length : null, conf: inBin.length ? mean(inBin.map((r) => r[k].conf)) : null };
  }),
}));

// Stability: share of cases whose answer was identical across 3 runs (main + 2 repeats)
summary.stability = (() => {
  const st = raw.stability ?? [];
  if (!st.length) return null;
  const same = (k) => mean(st.map((s) => {
    const first = raw.cases.find((r) => r.id === s.id);
    const qid = cases[s.id].q.id;
    const all = [k === "baseline" ? first.baseline.answer : first.cev.answers[qid].answer, ...s.runs.map((r) => r[k])];
    return all.every((a) => JSON.stringify(a) === JSON.stringify(all[0])) ? 1 : 0;
  }));
  return { n: st.length, baseline: same("baseline"), cev: same("cev") };
})();

if (raw.batch) {
  const t = raw.batch.together.meta;
  const s = raw.batch.single.map((r) => r.meta);
  const tokens = (m) => sum(Object.values(m.models).map((x) => x.tokensIn + x.tokensOut));
  summary.batch = {
    questions: raw.batch.single.length,
    together: { ms: t.ms, tokens: tokens(t) },
    single: { ms: sum(s.map((m) => m.ms)), tokens: sum(s.map(tokens)) },
    sameAnswers: raw.batch.single.every((r) => {
      const [id, a] = Object.entries(r.answers)[0];
      return JSON.stringify(a.answer) === JSON.stringify(raw.batch.together.answers[id].answer);
    }),
  };
}

writeFileSync(join(HERE, "results", `summary${sfx}.json`), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
