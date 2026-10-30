// cev — ask Claude and Codex the same bounded question and return their combined answer from a fixed set of options.
//
// request:  { state, rules?, questions: [{ id, type: "choice"|"bool"|"score", ask, options?, scale?, risk? }] }
// response: { answers: { [id]: { answer, conf, agree, escalate, why, missing } }, votes, meta }
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = join(homedir(), ".cev");
const RUN = join(HOME, "run");
export const CODEX_HOME = join(HOME, "codex-home");
// Codex built-in tools and features a decision never needs (dropping them shrinks the context)
export const CODEX_OFF = ["features.shell_tool", "features.unified_exec", "features.apps", "features.plugins", "features.memories", "features.multi_agent", "features.goals", "include_permissions_instructions", "include_environment_context"];
export const LOG = join(HOME, "log.jsonl");

// Escalation thresholds: the costlier a wrong answer, the more confidence an auto-answer needs
export const THRESHOLD = { low: 0.6, medium: 0.75, high: 0.9 };

export const SYSTEM = `You are a decision function, not a chat assistant.
Read STATE and RULES, then answer every QUESTION using only them.
- Probabilities are your honest, calibrated belief; each distribution sums to 1.
- If STATE lacks information the answer depends on, choose "abstain" (bool: abstain=true) and say what is missing in "missing". Never guess facts that are not in STATE.
- "evidence": a short verbatim quote (max 20 words) copied from STATE that most supports the answer; "" if none.
- Reply with the JSON object only.`;

// ── Which models to ask ──
// Warm, both models take ~2–4s per decision (Codex is the slower one); Claude alone ~1.5s.
// Ask Claude alone only when every question is low-risk. Score questions split the models most often, so they always get both.
export function route(req) {
  const solo = req.questions.every((q) => q.risk === "low" && q.type !== "score");
  return solo ? ["claude"] : ["claude", "codex"];
}

// Reject malformed requests before any model is called
export function checkRequest(req) {
  if (!req || req.state == null || !Array.isArray(req.questions) || !req.questions.length) throw new Error("need state and questions[]");
  for (const q of req.questions) {
    if (!q.id || !["choice", "bool", "score"].includes(q.type) || !q.ask) throw new Error(`bad question: ${JSON.stringify(q).slice(0, 120)}`);
    if (q.type === "choice" && !(Array.isArray(q.options) && q.options.length >= 2)) throw new Error(`${q.id}: choice needs options[]`);
  }
}

// ── Schemas: fix the answer shape per question type (OpenAI strict mode: every field required, no extra fields) ──
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const probsOf = (keys) => obj(Object.fromEntries(keys.map((k) => [k, { type: "number" }])));
const levelsOf = (q) => {
  const [lo, hi] = q.scale ?? [1, 5];
  return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
};
const TEXT = { type: "string" };

export function schemaOf(req) {
  const props = {};
  for (const q of req.questions) {
    if (q.type === "choice") {
      const keys = [...q.options, "abstain"];
      props[q.id] = obj({ choice: { type: "string", enum: keys }, probs: probsOf(keys), evidence: TEXT, missing: TEXT });
    } else if (q.type === "bool") {
      props[q.id] = obj({ p_yes: { type: "number" }, abstain: { type: "boolean" }, evidence: TEXT, missing: TEXT });
    } else if (q.type === "score") {
      const keys = [...levelsOf(q), "abstain"];
      props[q.id] = obj({ score: { type: "string", enum: keys }, probs: probsOf(keys), evidence: TEXT, missing: TEXT });
    } else throw new Error(`unknown question type: ${q.type}`);
  }
  return obj(props);
}

export function promptOf(req) {
  const questions = req.questions.map(({ id, type, ask, options, scale }) => ({ id, type, ask, ...(options && { options }), ...(type === "score" && { scale: scale ?? [1, 5] }) }));
  return JSON.stringify({ STATE: req.state, RULES: req.rules ?? [], QUESTIONS: questions });
}

// ── Runners: launch each CLI as a bare decision function, with as little context as possible ──
function run(cmd, args, { cwd, env, timeout = 120_000 }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Math.round(performance.now() - t0) });
    });
  });
}

export function prepare() {
  mkdirSync(RUN, { recursive: true });
  mkdirSync(CODEX_HOME, { recursive: true });
  const mcp = join(HOME, "empty-mcp.json");
  if (!existsSync(mcp)) writeFileSync(mcp, '{"mcpServers":{}}');
  // Codex runs from its own home that shares only auth, without the user's hooks, plugins and memories
  const auth = join(CODEX_HOME, "auth.json");
  if (!existsSync(auth)) symlinkSync(join(homedir(), ".codex", "auth.json"), auth);
  writeFileSync(join(CODEX_HOME, "config.toml"), 'web_search = "disabled"\n');
  writeFileSync(join(HOME, "system.md"), SYSTEM);
  return { mcp };
}

export async function askClaude(req, { model = "opus" } = {}) {
  const { mcp } = prepare();
  const r = await run(
    "claude",
    ["-p", promptOf(req), "--model", model, "--tools", "", "--output-format", "json", "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp, "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(schemaOf(req))],
    { cwd: RUN },
  );
  try {
    const j = JSON.parse(r.out);
    const u = Object.values(j.modelUsage ?? {})[0] ?? {};
    const tokensIn = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    const answer = j.structured_output ?? JSON.parse(j.result);
    return { ok: !j.is_error, answer, ms: r.ms, tokensIn, tokensOut: u.outputTokens ?? 0 };
  } catch (e) {
    return { ok: false, error: (r.err || r.out || String(e)).slice(0, 400), ms: r.ms, tokensIn: 0, tokensOut: 0 };
  }
}

export async function askCodex(req, { model = "gpt-6.1-sol", effort = "low" } = {}) {
  prepare();
  const schemaFile = join(RUN, `schema-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(schemaFile, JSON.stringify(schemaOf(req)));
  const r = await run(
    "codex",
    ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-m", model,
      "-c", `model_instructions_file="${join(HOME, "system.md")}"`, "-c", `model_reasoning_effort="${effort}"`,
      ...CODEX_OFF.flatMap((k) => ["-c", `${k}=false`]), "--output-schema", schemaFile, promptOf(req)],
    { cwd: RUN, env: { CODEX_HOME } },
  );
  let answer = null;
  let usage = {};
  for (const line of r.out.split("\n")) {
    if (!line.startsWith("{")) continue;
    const ev = JSON.parse(line);
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") answer = ev.item.text;
    if (ev.type === "turn.completed") usage = ev.usage;
    if (ev.type === "error" || ev.type === "turn.failed") r.err += JSON.stringify(ev);
  }
  try {
    if (!answer) throw new Error("no agent message");
    return { ok: true, answer: JSON.parse(answer), ms: r.ms, tokensIn: usage.input_tokens ?? 0, tokensOut: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0) };
  } catch {
    return { ok: false, error: (r.err || r.out).slice(-400), ms: r.ms, tokensIn: usage.input_tokens ?? 0, tokensOut: usage.output_tokens ?? 0 };
  }
}

// ── Combine: average the distributions, then escalate on disagreement or confidence below the risk threshold ──
const normalize = (probs) => {
  const sum = Object.values(probs).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, Math.max(0, v) / sum]));
};
const mean = (dists) => {
  const keys = Object.keys(dists[0]);
  return Object.fromEntries(keys.map((k) => [k, dists.reduce((a, d) => a + (d[k] ?? 0), 0) / dists.length]));
};
const argmax = (d) => Object.entries(d).sort((a, b) => b[1] - a[1])[0][0];
const round2 = (v) => Math.round(v * 100) / 100;

export function groundedIn(state, quote) {
  if (!quote) return null;
  const flat = (s) => String(typeof s === "string" ? s : JSON.stringify(s)).replace(/\s+/g, " ").trim().toLowerCase();
  return flat(state).includes(flat(quote).replace(/^["'“”]+|["'“”.…]+$/g, ""));
}

export function combine(req, votes) {
  const answers = {};
  for (const q of req.questions) {
    const vs = votes.map((v) => v?.[q.id]).filter(Boolean);
    const thr = THRESHOLD[q.risk ?? "medium"];
    const evidence = vs.map((v) => v.evidence).find((e) => e && groundedIn(req.state, e)) ?? "";
    const missing = vs.map((v) => v.missing).filter(Boolean).join(" / ");
    let answer, conf, agree;
    if (!vs.length) {
      answers[q.id] = { answer: "abstain", conf: 0, agree: false, escalate: true, why: "", missing: "no model answered" };
      continue;
    }
    if (q.type === "bool") {
      const anyAbstain = vs.some((v) => v.abstain);
      const p = vs.reduce((a, v) => a + v.p_yes, 0) / vs.length;
      answer = anyAbstain ? "abstain" : p >= 0.5;
      conf = anyAbstain ? 0 : Math.max(p, 1 - p);
      agree = !anyAbstain && vs.every((v) => v.p_yes >= 0.5 === p >= 0.5);
    } else {
      const field = q.type === "choice" ? "choice" : "score";
      const dist = mean(vs.map((v) => normalize(v.probs)));
      answer = argmax(dist);
      if (q.type === "score" && answer !== "abstain") {
        // Scores within one level of each other count as agreement
        const nums = vs.map((v) => Number(v[field]));
        agree = nums.every((n) => Number.isFinite(n)) && Math.max(...nums) - Math.min(...nums) <= 1;
        conf = [-1, 0, 1].reduce((a, d) => a + (dist[String(Number(answer) + d)] ?? 0), 0);
        answer = Number(answer);
      } else {
        agree = vs.every((v) => v[field] === vs[0][field]);
        conf = dist[answer];
      }
    }
    const escalate = answer === "abstain" || !agree || vs.length < votes.length || conf < thr;
    answers[q.id] = { answer, conf: round2(conf), agree, escalate, why: evidence, ...(missing && { missing }) };
  }
  return answers;
}

// ── Entry point ──
export async function decide(req, { models = ["claude", "codex"], log = true, claude = {}, codex = {} } = {}) {
  const t0 = performance.now();
  const calls = await Promise.all(models.map((m) => (m === "claude" ? askClaude(req, claude) : askCodex(req, codex))));
  const byModel = Object.fromEntries(models.map((m, i) => [m, calls[i]]));
  const answers = combine(req, calls.map((c) => (c.ok ? c.answer : null)));
  const meta = {
    ms: Math.round(performance.now() - t0),
    models: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, { ok: c.ok, ms: c.ms, tokensIn: c.tokensIn, tokensOut: c.tokensOut, ...(c.error && { error: c.error }) }])),
  };
  const result = { answers, votes: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, c.ok ? c.answer : null])), meta };
  if (log) {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), req, ...result }) + "\n");
  }
  return result;
}
