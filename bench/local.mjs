// Can a small local model answer some decisions in one forward pass? It is asked for a single option letter and the
// probabilities are read from the first token's logprobs (no text is generated), through a llama.cpp server.
// usage: node bench/local.mjs --url http://127.0.0.1:9941 --tag phi4mini [--only id,..]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { thresholdOf } from "../core/cev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const URL_ = arg("--url", "http://127.0.0.1:9941");
const TAG = arg("--tag", "local");
let cases = ["cases.json", "cases-hard.json"].flatMap((f) => JSON.parse(readFileSync(join(HERE, f), "utf8")).map((c) => ({ ...c, set: f === "cases.json" ? "base" : "hard" })));
if (arg("--only")) cases = cases.filter((c) => arg("--only").split(",").includes(c.id));

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXY";
const SYSTEM = `You are a decision function. Read STATE and RULES, then answer the QUESTION using only them.
If STATE lacks information the answer depends on, choose the "abstain" option. Never guess facts that are not in STATE.
Reply with the single letter of the chosen option and nothing else.`;
const valuesOf = (q) => (q.type === "choice" ? q.options : q.type === "bool" ? [true, false] : Array.from({ length: (q.scale ?? [1, 5])[1] - (q.scale ?? [1, 5])[0] + 1 }, (_, i) => (q.scale ?? [1, 5])[0] + i));
const labelOf = (v) => (v === true ? "yes" : v === false ? "no" : String(v));

async function ask(c) {
  const values = [...valuesOf(c.q), "abstain"];
  const user = `STATE: ${typeof c.state === "string" ? c.state : JSON.stringify(c.state)}\nRULES:\n${(c.rules ?? []).map((r) => `- ${r}`).join("\n")}\nQUESTION: ${c.q.ask}\nOPTIONS:\n${values.map((v, i) => `${LETTERS[i]}. ${labelOf(v)}`).join("\n")}\nAnswer with one letter.`;
  const t0 = performance.now();
  const r = await fetch(`${URL_}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20, cache_prompt: true }) });
  const j = await r.json();
  const ms = Math.round(performance.now() - t0);
  const top = j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
  const p = new Array(values.length).fill(0);
  for (const t of top) {
    const i = LETTERS.indexOf(String(t.token).trim().toUpperCase());
    if (String(t.token).trim().length === 1 && i >= 0 && i < values.length) p[i] += Math.exp(t.logprob);
  }
  const mass = p.reduce((a, b) => a + b, 0); // probability the model put on any valid letter at all
  const dist = mass ? p.map((x) => x / mass) : p;
  const best = dist.indexOf(Math.max(...dist));
  const answer = mass ? values[best] : "abstain";
  // score: confidence counts the neighbours, as cev does
  const conf = !mass || answer === "abstain" ? 0 : c.q.type === "score" ? [-1, 0, 1].reduce((a, d) => a + (best + d >= 0 && best + d < values.length - 1 ? dist[best + d] : 0), 0) : dist[best];
  return { answer, conf: +conf.toFixed(4), mass: +mass.toFixed(4), pAbstain: +dist[values.length - 1].toFixed(4), ms, promptTokens: j.usage?.prompt_tokens };
}
function outcome(c, answer, escalate) {
  const ok = [c.gold, ...(c.alt ?? [])];
  const shouldEscalate = c.gold === "escalate" || (c.alt ?? []).includes("escalate");
  const right = ok.some((g) => g !== "escalate" && g === answer);
  if (escalate) return c.gold === "escalate" || (shouldEscalate && !right) ? "escalate_ok" : right ? "safe_escalate" : "caught";
  return right ? "auto_right" : "auto_wrong";
}
await ask(cases[0]); // load the model and the system-prompt cache before timing
const rows = [];
for (const c of cases) {
  const a = await ask(c);
  const escalate = a.answer === "abstain" || a.conf < thresholdOf(c.q.risk);
  rows.push({ id: c.id, set: c.set, type: c.q.type, risk: c.q.risk ?? "medium", gold: c.gold, ...a, escalate, outcome: outcome(c, a.answer, escalate) });
}
const tally = (rs) => rs.reduce((t, r) => ({ ...t, [r.outcome]: (t[r.outcome] ?? 0) + 1 }), {});
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
// Sweep one confidence bar over all cases: how many does the local model answer on its own, and how many of those are wrong
const sweep = [0.6, 0.75, 0.9, 0.95, 0.98, 0.99, 0.995, 0.999].map((thr) => {
  const rs = rows.map((r) => outcome(cases.find((c) => c.id === r.id), r.answer, r.answer === "abstain" || r.conf < thr));
  return { thr, auto: rs.filter((o) => o.startsWith("auto")).length, wrong: rs.filter((o) => o === "auto_wrong").length };
});
const summary = { n: rows.length, ...tally(rows), msMedian: ms[Math.floor((ms.length - 1) / 2)], msP90: ms[Math.floor(ms.length * 0.9)], sweep };
writeFileSync(join(HERE, "results", `local-${TAG}.json`), JSON.stringify({ at: new Date().toISOString(), url: URL_, summary, rows }, null, 1));
console.log(TAG, JSON.stringify(summary));
for (const r of rows) if (r.outcome === "auto_wrong") console.log(`  wrong ${r.id} gold=${r.gold} got=${r.answer} conf=${r.conf}`);
