// Benchmark: measure the same decision made (A) by a stock Claude Code call and (B) by cev.
// usage: node bench/run.mjs [--cases file] [--tag name] [--only id,..] [--stability n] [--no-batch]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, HOME } from "../core/cev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results");
mkdirSync(OUT, { recursive: true });
if (process.argv.includes("--help")) {
  console.log("usage: node bench/run.mjs [--cases file] [--tag name] [--only id,..] [--stability n] [--no-batch]");
  process.exit(0);
}
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TAG = arg("--tag", "");
const RAW = join(OUT, `raw${TAG ? "-" + TAG : ""}.json`);
let cases = JSON.parse(readFileSync(join(HERE, arg("--cases", "cases.json")), "utf8"));
if (arg("--only")) cases = cases.filter((c) => arg("--only").split(",").includes(c.id));
const STABILITY = Number(arg("--stability", 8));

const reqOf = (c) => ({ state: c.state, rules: c.rules, questions: [c.q] });

// (A) stock Claude Code: full system prompt, tools and user settings, asked the way an agent would decide mid-conversation.
function baselinePrompt(c) {
  const q = c.q;
  const options = q.type === "choice" ? q.options.join(" / ") : q.type === "bool" ? "YES / NO" : `an integer ${(q.scale ?? [1, 5])[0]}-${(q.scale ?? [1, 5])[1]}`;
  return [
    "Make a decision about the situation below. Don't use any tools; answer directly.",
    `Situation: ${c.state}`,
    `Rules:\n${c.rules.map((r) => `- ${r}`).join("\n")}`,
    `Question: ${q.ask}`,
    `Options: ${options} (ABSTAIN if there isn't enough information to decide)`,
    'Explain your reasoning, then end with a last line of exactly "ANSWER: <value>".',
  ].join("\n");
}
function claudeDefault(prompt) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn("claude", ["-p", prompt, "--model", "opus", "--output-format", "json", "--no-session-persistence"], { cwd: join(HOME, "run"), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      const ms = Math.round(performance.now() - t0);
      try {
        const j = JSON.parse(out);
        const u = Object.values(j.modelUsage ?? {})[0] ?? {};
        resolve({ ok: !j.is_error, text: j.result, ms, tokensIn: (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), tokensOut: u.outputTokens ?? 0, costUSD: u.costUSD ?? 0 });
      } catch {
        resolve({ ok: false, text: out.slice(0, 400), ms, tokensIn: 0, tokensOut: 0, costUSD: 0 });
      }
    });
  });
}
function parseBaseline(c, text) {
  const m = /ANSWER:\s*\**\s*([^\s*`]+)/i.exec(text ?? "");
  if (!m) return { parsed: false, answer: null };
  const raw = m[1].trim().replace(/[.。]$/, "");
  if (/^abstain$/i.test(raw)) return { parsed: true, answer: "abstain" };
  if (c.q.type === "bool") return /^yes$/i.test(raw) ? { parsed: true, answer: true } : /^no$/i.test(raw) ? { parsed: true, answer: false } : { parsed: false, answer: raw };
  if (c.q.type === "score") return Number.isFinite(Number(raw)) ? { parsed: true, answer: Number(raw) } : { parsed: false, answer: raw };
  return c.q.options.includes(raw) ? { parsed: true, answer: raw } : { parsed: false, answer: raw };
}

const results = { at: new Date().toISOString(), cases: [], stability: [], batch: null, calib: null };

// Fixed cost: send a near-empty prompt with the same setup to measure the system prompt
const calib = await claudeDefault("OK");
results.calib = { tokensIn: calib.tokensIn, ms: calib.ms };
console.log(`baseline fixed overhead: ${calib.tokensIn} tokens, ${calib.ms} ms`);

for (const c of cases) {
  const prompt = baselinePrompt(c);
  const [base, cev] = await Promise.all([claudeDefault(prompt), decide(reqOf(c), { log: false })]);
  const parsed = parseBaseline(c, base.text);
  results.cases.push({ id: c.id, baseline: { ...base, ...parsed, promptChars: prompt.length }, cev });
  const a = cev.answers[c.q.id];
  console.log(`${c.id.padEnd(8)} gold=${String(c.gold).padEnd(8)} base=${String(parsed.answer).padEnd(8)} ${String(base.ms).padStart(6)}ms | cev=${String(a.answer).padEnd(8)} esc=${a.escalate ? "Y" : "n"} conf=${a.conf} ${String(cev.meta.ms).padStart(6)}ms`);
  writeFileSync(RAW, JSON.stringify(results, null, 1));
}

// Stability: repeat the decision twice more and see whether the answer changes
for (const c of cases.slice(0, STABILITY)) {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const [base, cev] = await Promise.all([claudeDefault(baselinePrompt(c)), decide(reqOf(c), { log: false })]);
    runs.push({ baseline: parseBaseline(c, base.text).answer, cev: cev.answers[c.q.id].answer, claude: cev.votes.claude?.[c.q.id], codex: cev.votes.codex?.[c.q.id] });
  }
  results.stability.push({ id: c.id, runs });
  console.log(`stability ${c.id}: ${runs.map((r) => `${r.baseline}/${r.cev}`).join(" ")}`);
  writeFileSync(RAW, JSON.stringify(results, null, 1));
}

// Batching: four questions about one state in one call vs one at a time
if (process.argv.includes("--no-batch")) process.exit(0);
const batchReq = {
  state: "PR #733 in acme/widget: bumps lodash 4.17.20 → 4.17.21 in package.json and the lockfile. Opened by the dependency bot. CI: 41/41 checks passed. Changelog: security fix for prototype pollution. 2 of the 3 required reviewers are on leave this week.",
  rules: ["Patch-level dependency bumps with passing CI may be auto-merged", "Security fixes are released within 48 hours", "Any change to more than package.json and the lockfile needs human review"],
  questions: [
    { id: "action", type: "choice", ask: "What should happen to this PR?", options: ["automerge", "review", "close"], risk: "low" },
    { id: "patch", type: "bool", ask: "Is this a patch-level bump?" },
    { id: "ci_ok", type: "bool", ask: "Did CI pass?" },
    { id: "deps_only", type: "bool", ask: "Does it change only package.json and the lockfile?" },
  ],
};
const together = await decide(batchReq, { log: false });
const single = [];
for (const q of batchReq.questions) single.push(await decide({ ...batchReq, questions: [q] }, { log: false }));
results.batch = { together, single };
writeFileSync(RAW, JSON.stringify(results, null, 1));
console.log(`batch: together ${together.meta.ms}ms, single total ${single.reduce((a, r) => a + r.meta.ms, 0)}ms`);
