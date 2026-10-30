// summary.json → report.html (charts drawn directly as inline SVG)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TAG = arg("--tag", "");
const sfx = TAG ? "-" + TAG : "";
const { summary: S, rows } = JSON.parse(readFileSync(join(HERE, "results", `summary${sfx}.json`), "utf8"));
const cases = Object.fromEntries(JSON.parse(readFileSync(join(HERE, arg("--cases", "cases.json")), "utf8")).map((c) => [c.id, c]));

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const T = S.tokens;
const baseTotal = T.baselineIn + T.baselineOut;
const cevTotal = T.claudeIn + T.claudeOut + T.codexIn + T.codexOut;
const Q = S.quality;

// ── bar chart (horizontal) ──
function hbars(items, { unit = "", max, width = 640, row = 34, label = 150 } = {}) {
  const m = max ?? Math.max(...items.map((i) => i.parts.reduce((a, p) => a + p.v, 0)));
  const plot = width - label - 70;
  const h = items.length * row + 8;
  let svg = `<svg viewBox="0 0 ${width} ${h}" role="img" class="chart">`;
  items.forEach((it, i) => {
    const y = i * row + 6;
    svg += `<text x="${label - 10}" y="${y + row / 2 - 2}" class="lab" text-anchor="end">${esc(it.name)}</text>`;
    let x = label;
    for (const p of it.parts) {
      const w = Math.max(p.v > 0 ? 1.5 : 0, (p.v / m) * plot);
      svg += `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${row - 14}" rx="2" fill="var(${p.c})"><title>${esc(p.t ?? "")} ${fmt(p.v)}${unit}</title></rect>`;
      x += w;
    }
    svg += `<text x="${(x + 8).toFixed(1)}" y="${y + row / 2 - 2}" class="num">${esc(it.total ?? fmt(it.parts.reduce((a, p) => a + p.v, 0)) + unit)}</text>`;
  });
  return svg + "</svg>";
}

// ── cumulative chart: tokens piled into the main conversation after N decisions ──
function growth() {
  const W = 640, H = 230, L = 56, B = 30, N = 50;
  const yMax = Math.ceil((S.mainCtx.base * N) / 10000) * 10000;
  const X = (n) => L + (n / N) * (W - L - 16);
  const Y = (v) => H - B - (v / yMax) * (H - B - 12);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (let v = 0; v <= yMax; v += yMax / 4) svg += `<line x1="${L}" x2="${W - 16}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 8}" y="${Y(v) + 4}" class="tick" text-anchor="end">${v >= 1000 ? `${v / 1000}k` : v}</text>`;
  for (const n of [0, 10, 20, 30, 40, 50]) svg += `<text x="${X(n)}" y="${H - 10}" class="tick" text-anchor="middle">${n}</text>`;
  const line = (per, cls) => `<polyline class="${cls}" points="${[0, N].map((n) => `${X(n).toFixed(1)},${Y(per * n).toFixed(1)}`).join(" ")}"/>`;
  svg += line(S.mainCtx.base, "ln-base") + line(S.mainCtx.cev, "ln-cev");
  svg += `<text x="${X(N) - 4}" y="${Y(S.mainCtx.base * N) - 8}" class="num" text-anchor="end">baseline ${fmt(S.mainCtx.base * N)}</text>`;
  svg += `<text x="${X(N) - 4}" y="${Y(S.mainCtx.cev * N) - 8}" class="num" text-anchor="end">cev ${fmt(S.mainCtx.cev * N)}</text>`;
  svg += `<text x="${L}" y="${H - 10 + 0}" class="tick" text-anchor="start" dx="-4"></text>`;
  return svg + "</svg>";
}

// ── dot chart: latency per decision ──
function strip() {
  const W = 640, H = 170, L = 120, R = 16;
  const all = rows.flatMap((r) => [r.base.ms, r.cev.ms, r.claude.ms, r.codex.ms]);
  const max = Math.ceil(Math.max(...all) / 5000) * 5000;
  const X = (ms) => L + (ms / max) * (W - L - R);
  const lanes = [["baseline", "base", "--c-base"], ["cev total", "cev", "--c-cev"], ["· Claude", "claude", "--c-claude"], ["· Codex", "codex", "--c-codex"]];
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (let v = 0; v <= max; v += 5000) svg += `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${H - 26}" class="grid"/><text x="${X(v)}" y="${H - 8}" class="tick" text-anchor="middle">${v / 1000}s</text>`;
  lanes.forEach(([name, k, c], i) => {
    const y = 22 + i * 34;
    svg += `<text x="${L - 10}" y="${y + 4}" class="lab" text-anchor="end">${name}</text>`;
    for (const r of rows) svg += `<circle cx="${X(r[k].ms).toFixed(1)}" cy="${y}" r="4.2" fill="var(${c})" fill-opacity=".55"><title>${r.id} ${sec(r[k].ms)}</title></circle>`;
    const med = S.ms[k].median;
    svg += `<line x1="${X(med)}" x2="${X(med)}" y1="${y - 10}" y2="${y + 10}" class="med"/>`;
  });
  return svg + "</svg>";
}

// ── outcome breakdown bars ──
const OUTCOMES = [
  ["auto_right", "auto, correct", "--ok"],
  ["escalate_ok", "escalated, as it should", "--ok-soft"],
  ["safe_escalate", "correct, but escalated", "--warn-soft"],
  ["caught", "wrong or abstained, escalated", "--warn"],
  ["auto_wrong", "auto, wrong", "--bad"],
];
function outcomes() {
  const sys = [["baseline (Claude Code)", Q.base], ["Claude only", Q.claude], ["Codex only", Q.codex], ["cev (both)", Q.cev]];
  return hbars(sys.map(([name, q]) => ({ name, total: `${q.auto_wrong} wrong`, parts: OUTCOMES.map(([k, t, c]) => ({ v: q[k], c, t })) })), { max: S.n, label: 170 });
}

const legend = OUTCOMES.map(([, t, c]) => `<span class="key"><i style="background:var(${c})"></i>${t}</span>`).join("");

const tableRows = rows.map((r) => {
  const c = cases[r.id];
  const mark = (o) => ({ auto_right: "ok", escalate_ok: "ok", safe_escalate: "soft", caught: "soft", auto_wrong: "bad" })[o];
  const show = (a, escalate) => `${esc(a === true ? "YES" : a === false ? "NO" : a ?? "–")}${escalate ? " <em>→ human</em>" : ""}`;
  return `<tr><td class="mono">${r.id}</td><td>${esc(c.kind ?? c.domain)}</td><td class="mono">${esc(r.gold === true ? "YES" : r.gold === false ? "NO" : r.gold)}</td>
  <td class="${mark(r.base.outcome)}">${show(r.base.answer, r.base.answer === "abstain")}</td>
  <td class="${mark(r.cev.outcome)}">${show(r.cev.answer, r.cev.escalate)} <span class="dim">${r.cev.conf}</span></td>
  <td class="mono dim">${esc(String(r.claude.answer))} / ${esc(String(r.codex.answer))}</td>
  <td class="mono r">${sec(r.base.ms)}</td><td class="mono r">${sec(r.cev.ms)}</td></tr>`;
}).join("");

const calib = S.calibration.map((c) => `<tr><td>${{ claude: "Claude", codex: "Codex", cev: "cev" }[c.who]}</td>${c.bins.map((b) => `<td class="mono">${b.n ? `${pct(b.acc)} <span class="dim">(n=${b.n}, mean ${b.conf.toFixed(2)})</span>` : "–"}</td>`).join("")}</tr>`).join("");

// ── speed experiment (if speed.json exists) ──
let speedHtml = "";
try {
  const sp = JSON.parse(readFileSync(join(HERE, "results", "speed.json"), "utf8"));
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const p90s = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
  const vs = sp.variants.map((v) => ({ name: v.name, med: med(v.rows.map((r) => r.ms)), p90: p90s(v.rows.map((r) => r.ms)), acc: v.rows.filter((r) => r.right).length / v.rows.length, claude: med(v.rows.filter((r) => r.models.claude).map((r) => r.models.claude.ms)), codex: v.rows.some((r) => r.models.codex) ? med(v.rows.filter((r) => r.models.codex).map((r) => r.models.codex.ms)) : null }));
  const base = vs[0].med;
  speedHtml = `<section>
  <h2>8. Ways to make it faster</h2>
  <p class="lede">The same ${sp.cases.length} decisions, run sequentially, changing only how they're executed. cold is the current approach, launching a fresh CLI per decision; warm keeps a Claude process and a Codex server running and only sends the question.</p>
  ${hbars(vs.map((v) => ({ name: v.name, total: `${sec(v.med)} · ${(base / v.med).toFixed(1)}×`, parts: [{ v: v.med, c: v.name.startsWith("cold") ? "--c-base" : "--c-cev", t: "median ms" }] })), { label: 210 })}
  <div class="scroll"><table><thead><tr><th>method</th><th class="r">median</th><th class="r">p90</th><th class="r">Claude</th><th class="r">Codex</th><th class="r">correct</th></tr></thead><tbody>
  ${vs.map((v) => `<tr><td>${esc(v.name)}</td><td class="mono r">${sec(v.med)}</td><td class="mono r">${sec(v.p90)}</td><td class="mono r">${sec(v.claude)}</td><td class="mono r">${v.codex == null ? "–" : sec(v.codex)}</td><td class="mono r">${pct(v.acc)}</td></tr>`).join("")}
  </tbody></table></div>
</section>`;
} catch {}
let easyHtml = "";
if (TAG) {
  try {
    const E = JSON.parse(readFileSync(join(HERE, "results", "summary.json"), "utf8")).summary;
    const row = (name, f) => `<tr><td>${name}</td><td class="mono r">${f(E, "base")}</td><td class="mono r">${f(S, "base")}</td><td class="mono r">${f(E, "cev")}</td><td class="mono r">${f(S, "cev")}</td></tr>`;
    easyHtml = `<section>
  <h2>Compared with the easy set</h2>
  <div class="scroll"><table><thead><tr><th></th><th class="r">baseline · easy</th><th class="r">baseline · hard</th><th class="r">cev · easy</th><th class="r">cev · hard</th></tr></thead><tbody>
  ${row("accuracy", (X, k) => pct(X.quality[k].correct))}
  ${row("auto-executed wrong", (X, k) => `${X.quality[k].auto_wrong}`)}
  ${row("auto rate", (X, k) => pct(X.quality[k].autoRate))}
  ${row("auto precision", (X, k) => pct(X.quality[k].autoPrecision))}
  ${row("median latency", (X, k) => sec(X.ms[k].median))}
  </tbody></table></div>
</section>`;
  } catch {}
}

const qualityNote = (() => {
  const b = Q.base, c = Q.cev;
  const parts = [`Accuracy: baseline ${pct(b.correct)}, cev ${pct(c.correct)}.`];
  parts.push(`Wrong answers executed without human review: baseline ${b.auto_wrong}, cev ${c.auto_wrong}.`);
  if (c.safe_escalate + c.caught) parts.push(`cev escalated ${c.safe_escalate + c.caught} to a human; in ${c.safe_escalate} of those the answer itself was correct. That's because it's deliberately conservative: it escalates if either model abstains or the two disagree.`);
  return parts.join(" ");
})();
const subtitle = TAG ? "Hard decisions: rule conflicts, boundary values, hidden instructions, required arithmetic" : "Basic decisions answerable from the rules alone";

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CEV Decision Bench</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* measurement report: single left-aligned column, monospace numbers, color only for the compared systems (baseline vs cev) and outcome meaning */
:root{
  --bg:#f4f5f1;--panel:#fbfbf8;--ink:#1c211d;--soft:#5d665f;--line:#d9ddd5;
  --c-base:#8a6f4d;--c-cev:#2d5bb8;--c-claude:#c46a3a;--c-codex:#3a8a7a;--c-fixed:#cdbfa9;
  --ok:#3b8a5a;--ok-soft:#9cc9a8;--warn-soft:#e8d29a;--warn:#d9a441;--bad:#c4473a;
  --sans:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#141815;--panel:#1b201c;--ink:#e6e9e3;--soft:#9aa49c;--line:#2e352f;
  --c-base:#c19c6c;--c-cev:#6f97ea;--c-claude:#e08a5a;--c-codex:#5fb7a4;--c-fixed:#5a4f40;
  --ok:#5fb27f;--ok-soft:#3f6b4d;--warn-soft:#6e6136;--warn:#d9a441;--bad:#e06a5c;color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#141815;--panel:#1b201c;--ink:#e6e9e3;--soft:#9aa49c;--line:#2e352f;
  --c-base:#c19c6c;--c-cev:#6f97ea;--c-claude:#e08a5a;--c-codex:#5fb7a4;--c-fixed:#5a4f40;
  --ok:#5fb27f;--ok-soft:#3f6b4d;--warn-soft:#6e6136;--warn:#d9a441;--bad:#e06a5c;color-scheme:dark}
body{background:var(--bg);color:var(--ink);font:15px/1.65 var(--sans);padding-inline:20px;padding-block:40px 64px}
main{max-width:860px;margin:0 auto;display:grid;gap:44px}
h1{font-size:30px;line-height:1.25;margin:0;text-wrap:balance;letter-spacing:-.01em}
h2{font-size:19px;margin:0 0 4px;text-wrap:balance}
p{margin:0;max-width:66ch}
.eyebrow{font:500 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}
.lede{color:var(--soft)}
section{display:grid;gap:14px;min-width:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;display:grid;gap:4px}
.tile b{font:500 26px/1.15 var(--mono);font-variant-numeric:tabular-nums}
.tile .vs{font:13px var(--mono);color:var(--soft)}
.tile small{color:var(--soft);font-size:13px}
.chart{width:100%;height:auto;max-width:100%;display:block}
.chart .lab{font:13px var(--sans);fill:var(--ink)}
.chart .num{font:500 12.5px var(--mono);fill:var(--ink)}
.chart .tick{font:11px var(--mono);fill:var(--soft)}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .med{stroke:var(--ink);stroke-width:2}
.chart .ln-base{fill:none;stroke:var(--c-base);stroke-width:2.5}
.chart .ln-cev{fill:none;stroke:var(--c-cev);stroke-width:2.5}
.keys{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--soft)}
.key{display:inline-flex;align-items:center;gap:6px}.key i{width:10px;height:10px;border-radius:2px;display:inline-block}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13.5px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{font:500 11.5px var(--mono);letter-spacing:.06em;color:var(--soft);text-transform:uppercase}
tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono)}.r{text-align:right}.dim{color:var(--soft)}
td.ok{color:var(--ok)}td.soft{color:var(--warn)}td.bad{color:var(--bad);font-weight:700}
td em{font-style:normal;color:var(--soft)}
.aids{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.aid{border-top:2px solid var(--line);padding-top:10px;display:grid;gap:4px;min-width:0}
.aid.new{border-top-color:var(--c-cev)}
.aid h3{margin:0;font-size:15px}.aid p{font-size:14px;color:var(--soft)}
.aid .tag{font:500 11px var(--mono);letter-spacing:.08em;color:var(--soft)}
.aid.new .tag{color:var(--c-cev)}
ul{margin:0;padding-left:20px;display:grid;gap:6px;max-width:70ch}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
</style>
<main>
<header style="display:grid;gap:10px">
  <span class="eyebrow">Benchmark · ${S.n} decisions · ${S.at.slice(0, 10)}</span>
  <h1>Deciding directly vs handing it to cev</h1>
  <p class="eyebrow" style="text-transform:none;letter-spacing:.02em">${subtitle}</p>
  <p class="lede">The same ${S.n} decisions, handled two ways. <b>Baseline</b> is Claude Code (Opus, with its full system prompt and tools) deciding mid-conversation, as usual. <b>cev</b> asks a stripped-down, decision-only Claude Opus and Codex (gpt-6.1-sol, reasoning low) in parallel and combines the answers.</p>
</header>

<section>
  <div class="tiles">
    <div class="tile"><span class="eyebrow">Tokens left in main conversation</span><b>${fmt(S.mainCtx.cev)}</b><span class="vs">baseline ${fmt(S.mainCtx.base)}</span><small>Median per decision. ${(S.mainCtx.base / S.mainCtx.cev).toFixed(1)}× fewer</small></div>
    <div class="tile"><span class="eyebrow">Total tokens processed</span><b>${fmt(cevTotal)}</b><span class="vs">baseline ${fmt(baseTotal)}</span><small>${(baseTotal / cevTotal).toFixed(1)}× fewer, even with two models</small></div>
    <div class="tile"><span class="eyebrow">Median latency</span><b>${sec(S.ms.cev.median)}</b><span class="vs">baseline ${sec(S.ms.base.median)}</span><small>p90: cev ${sec(S.ms.cev.p90)} · baseline ${sec(S.ms.base.p90)}</small></div>
    <div class="tile"><span class="eyebrow">Wrong answers auto-executed</span><b>${Q.cev.auto_wrong}</b><span class="vs">baseline ${Q.base.auto_wrong}</span><small>A wrong answer executed without human review</small></div>
  </div>
</section>

<section>
  <h2>1. Tokens per decision</h2>
  <p class="lede">Baseline reads Claude Code's system prompt and tool definitions (about ${fmt(S.fixedOverhead.baseline)} tokens) every time. cev sends only the instructions the decision needs.</p>
  ${hbars([
    { name: "baseline", parts: [{ v: S.fixedOverhead.baseline, c: "--c-fixed", t: "fixed overhead" }, { v: Math.max(0, T.baselineIn - S.fixedOverhead.baseline), c: "--c-base", t: "question + hook-injected context" }, { v: T.baselineOut, c: "--bad", t: "output" }] },
    { name: "cev · Claude", parts: [{ v: T.claudeIn, c: "--c-claude", t: "input" }, { v: T.claudeOut, c: "--bad", t: "output" }] },
    { name: "cev · Codex", parts: [{ v: T.codexIn, c: "--c-codex", t: "input" }, { v: T.codexOut, c: "--bad", t: "output" }] },
  ], { unit: "" })}
  <div class="keys"><span class="key"><i style="background:var(--c-fixed)"></i>Claude Code fixed overhead</span><span class="key"><i style="background:var(--c-base)"></i>question + hook context</span><span class="key"><i style="background:var(--c-claude)"></i>Claude input</span><span class="key"><i style="background:var(--c-codex)"></i>Codex input (incl. built-in instructions)</span><span class="key"><i style="background:var(--bad)"></i>output</span></div>
</section>

<section>
  <h2>2. How heavy the main conversation gets</h2>
  <p class="lede">This matters more. With the baseline, the agent's written reasoning (median ${fmt(S.mainCtx.base)} tokens) stays in the conversation and is re-read on every later turn. With cev, only the request (${fmt(S.mainCtx.cevCall)}) and the compact result (${fmt(S.mainCtx.cevResult)}) remain.</p>
  ${growth()}
  <div class="keys"><span class="key"><i style="background:var(--c-base)"></i>baseline</span><span class="key"><i style="background:var(--c-cev)"></i>cev</span><span>x: number of decisions · y: tokens accumulated in main conversation</span></div>
</section>

<section>
  <h2>3. Latency</h2>
  <p class="lede">Each dot is one decision; the vertical bar is the median. cev calls both models in parallel, so the slower one (Codex) sets the total time.</p>
  ${strip()}
</section>

<section>
  <h2>4. Decision quality</h2>
  <p class="lede">Of the ${S.n} decisions with known answers, ${rows.filter((r) => r.gold === "escalate").length} deliberately omit information (correct answer = escalate to a human). The worst outcome, in red, is a wrong answer executed without human review.</p>
  <p>${qualityNote}</p>
  ${outcomes()}
  <div class="keys">${legend}</div>
  <div class="split">
    <div class="tile"><span class="eyebrow">Auto rate · auto precision</span><b>${pct(Q.cev.autoRate)} · ${pct(Q.cev.autoPrecision)}</b><span class="vs">baseline ${pct(Q.base.autoRate)} · ${pct(Q.base.autoPrecision)}</span><small>Share of decisions cev handled itself, and the share of those it got right</small></div>
    <div class="tile"><span class="eyebrow">Model agreement</span><b>${pct(S.agreeRate)}</b><span class="vs">disagreement goes to a human automatically</span><small>Every decision where they disagree is escalated</small></div>
    <div class="tile"><span class="eyebrow">Evidence quote check</span><b>${pct(S.grounding.claude)} / ${pct(S.grounding.codex)}</b><span class="vs">Claude / Codex</span><small>Share of cited evidence sentences that actually appear in the situation</small></div>
    <div class="tile"><span class="eyebrow">Format compliance</span><b>${pct(Math.min(S.format.claudeOk, S.format.codexOk))}</b><span class="vs">baseline answer extraction ${pct(S.format.baselineParsed)}</span><small>Answer format enforced by schema</small></div>
    ${S.stability ? `<div class="tile"><span class="eyebrow">Repeat consistency (${S.stability.n} × 3 runs)</span><b>${pct(S.stability.cev)}</b><span class="vs">baseline ${pct(S.stability.baseline)}</span><small>Share of decisions where all 3 runs gave the same answer</small></div>` : ""}
    ${S.batch ? `<div class="tile"><span class="eyebrow">${S.batch.questions} questions in 1 call</span><b>${sec(S.batch.together.ms)}</b><span class="vs">one at a time, ${S.batch.questions} calls: ${sec(S.batch.single.ms)}</span><small>tokens ${fmt(S.batch.together.tokens)} vs ${fmt(S.batch.single.tokens)} · answers ${S.batch.sameAnswers ? "identical" : "partly different"}</small></div>` : ""}
  </div>
</section>

<section>
  <h2>5. Is the confidence calibrated?</h2>
  <p class="lede">Decisions not escalated to a human, bucketed by confidence, with actual accuracy per bucket. Higher confidence should mean higher accuracy. The sample is small, so treat this as a trend only.</p>
  <div class="scroll"><table><thead><tr><th></th><th>conf &lt; 0.75</th><th>0.75 – 0.9</th><th>≥ 0.9</th></tr></thead><tbody>${calib}</tbody></table></div>
</section>

<section>
  <h2>6. Decision aids</h2>
  <p class="lede">Jev's three question types are kept as-is, plus six more aids for decision quality.</p>
  <div class="aids">
    <div class="aid"><span class="tag">JEV · 1</span><h3>Yes/no (bool)</h3><p>Returns a single probability of YES. "Is it safe to delete?", "Should this be blocked?"</p></div>
    <div class="aid"><span class="tag">JEV · 2</span><h3>Choice (choice)</h3><p>One of a fixed set of options, with a probability per option. Routing, classification</p></div>
    <div class="aid"><span class="tag">JEV · 3</span><h3>Score (score)</h3><p>A position on a fixed scale, with a probability per level. Rubric grading</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Abstain + missing info</h3><p>Every question has an "abstain" option; choosing it means stating what's missing. Keeps the model from forcing a guess</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Evidence quote check</h3><p>The model must quote evidence verbatim from the situation, and code checks that the sentence actually exists</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Risk-based thresholds</h3><p>Each question is tagged low / medium / high. Confidence below 0.6 / 0.75 / 0.9 respectively goes to a human</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Rule list</h3><p>Decision criteria are sent separately from the situation. The same rules can judge many situations, and you can change only the rules and re-evaluate</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Two-model cross-check</h3><p>If Claude and Codex answer differently, it escalates regardless of confidence. Guards against one model's confident mistake</p></div>
    <div class="aid new"><span class="tag">CEV · added</span><h3>Decision log</h3><p>The request and both models' answers are written to ~/.cev/log.jsonl, which becomes the next eval set as-is</p></div>
  </div>
</section>

<section>
  <h2>7. Results per decision</h2>
  <div class="scroll"><table><thead><tr><th>id</th><th>${rows.some((r) => cases[r.id].kind) ? "kind" : "domain"}</th><th>gold</th><th>baseline</th><th>cev · conf</th><th>Claude / Codex</th><th class="r">baseline</th><th class="r">cev</th></tr></thead><tbody>${tableRows}</tbody></table></div>
</section>

${easyHtml}
${speedHtml}
<section>
  <h2>Reading these results</h2>
  <ul>
    <li>The decision problems and answers were written by me (Claude). They're designed to be answerable from the rules alone, but there may be a bias in Claude's favor.</li>
    <li>${S.n} decisions is a small sample. Look at the large differences (total tokens, latency, whether wrong answers occur) rather than individual percentages.</li>
    <li>Token counts are as reported by the CLIs. Main-conversation tokens are estimated: character count times a measured ratio (${S.tokPerChar.toFixed(2)} tokens per character).</li>
    <li>Baseline output includes the currently enabled output style (Learning, with insight blocks). It was left on because that matches real sessions.</li>
    <li>Runs use subscription quota. Timings vary with network and server load, and include the few seconds spent launching a fresh process per call.</li>
  </ul>
</section>
</main>`;

const out = join(HERE, "results", `report${sfx}.html`);
writeFileSync(out, html);
console.log("wrote", out);
