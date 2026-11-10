// cev — ask Claude and Codex the same bounded question and return their combined answer from a fixed set of options.
//
// request:  { state, rules?, questions: [{ id, type: "choice"|"bool"|"score", ask, options?, scale?, risk? }] }
// response: { answers: { [id]: { answer, conf, agree, escalate, why, missing } }, votes, meta }
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, symlinkSync, copyFileSync, rmSync, lstatSync, chmodSync } from "node:fs";
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
// Claude answers every decision. Codex is an opt-in second opinion (CEV_CODEX=1): in the benchmarks it caught no
// confident error lean Claude made, and it roughly doubles latency (warm: Claude ~1.5s, both ~2–4s).
export const codexEnabled = () => process.env.CEV_CODEX === "1";

// Which Claude answers, and how hard it thinks. An alias ("opus") follows the newest model of that tier; a full id
// pins one. Unset effort leaves the CLI's default. A bad value throws: a typo must not silently pick another model.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export function claudeConfig(env = process.env) {
  const model = env.CEV_CLAUDE_MODEL || "opus";
  const effort = env.CEV_CLAUDE_EFFORT || undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(model)) throw new Error(`CEV_CLAUDE_MODEL is not a model name: ${JSON.stringify(model)}`);
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`CEV_CLAUDE_EFFORT must be one of ${EFFORTS.join(", ")}`);
  return { model, effort };
}

// When enabled, keep the routing the panel benchmarks measured: Claude alone only when every question is low-risk
// and none is a score (scores split the two models most often). Unset risk means medium, so it gets both.
export function route(req, { codex = codexEnabled() } = {}) {
  if (!codex) return ["claude"];
  const solo = req.questions.every((q) => q.risk === "low" && q.type !== "score");
  return solo ? ["claude"] : ["claude", "codex"];
}

// Reject malformed requests before any model is called. A bad field must fail here, not fall through to a default
// (an unknown risk would otherwise have no threshold and never escalate).
export const RISKS = Object.keys(THRESHOLD);
export const LIMITS = { questions: 20, options: 20, levels: 21, scaleAbs: 1_000_000 };
// Ids become JSON object keys in the schema and the answers: keep them plain so none can collide with Object.prototype
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const thresholdOf = (risk) => (Object.hasOwn(THRESHOLD, risk ?? "medium") ? THRESHOLD[risk ?? "medium"] : THRESHOLD.high);
const bad = (msg) => {
  throw new Error(msg);
};
export function checkRequest(req) {
  if (!req || req.state == null || !Array.isArray(req.questions) || !req.questions.length) bad("need state and questions[]");
  if (req.questions.length > LIMITS.questions) bad(`at most ${LIMITS.questions} questions per request`);
  const ids = new Set();
  for (const q of req.questions) {
    if (!q || typeof q !== "object" || !["choice", "bool", "score"].includes(q.type) || typeof q.ask !== "string" || !q.ask.trim()) bad(`bad question: ${JSON.stringify(q)?.slice(0, 120)}`);
    if (typeof q.id !== "string" || !ID.test(q.id)) bad(`bad question id ${JSON.stringify(q.id)}: use letters, digits, _ or -, starting with a letter`);
    if (ids.has(q.id)) bad(`duplicate question id ${q.id}`);
    ids.add(q.id);
    if (q.risk !== undefined && !RISKS.includes(q.risk)) bad(`${q.id}: risk must be one of ${RISKS.join(", ")}`);
    if (q.type === "choice") {
      const o = q.options;
      if (!(Array.isArray(o) && o.length >= 2)) bad(`${q.id}: choice needs options[]`);
      if (o.length > LIMITS.options || o.some((x) => typeof x !== "string" || !x) || new Set(o).size !== o.length) bad(`${q.id}: options must be up to ${LIMITS.options} distinct non-empty strings`);
      if (o.includes("abstain")) bad(`${q.id}: "abstain" is reserved`);
    }
    if (q.type === "score" && q.scale !== undefined) {
      const [lo, hi] = Array.isArray(q.scale) ? q.scale : [];
      const int = (n) => Number.isSafeInteger(n) && Math.abs(n) <= LIMITS.scaleAbs;
      if (q.scale.length !== 2 || !int(lo) || !int(hi) || hi <= lo || hi - lo + 1 > LIMITS.levels) bad(`${q.id}: scale must be [lo, hi] integers with up to ${LIMITS.levels} levels`);
    }
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
export const keysOf = (q) => [...(q.type === "choice" ? q.options : levelsOf(q)), "abstain"];
const fieldOf = (q) => (q.type === "choice" ? "choice" : "score");

// A vote counts only if it has the exact shape the schema promises. The warm Claude path has no schema enforcement,
// and even strict mode can't bound numbers, so an out-of-range vote is dropped (and so escalates) rather than averaged.
const isProb = (v) => typeof v === "number" && v >= 0 && v <= 1;
// Exactly these keys, as the strict schema says (additionalProperties: false)
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
export function validVote(q, a) {
  const fields = q.type === "bool" ? ["p_yes", "abstain", "evidence", "missing"] : [fieldOf(q), "probs", "evidence", "missing"];
  if (!exactKeys(a, fields)) return false;
  // evidence and missing are required by the schema; a vote without them didn't follow it
  if (typeof a.evidence !== "string" || typeof a.missing !== "string") return false;
  if (q.type === "bool") return isProb(a.p_yes) && typeof a.abstain === "boolean";
  const keys = keysOf(q);
  // Exactly a string key: String(["abstain"]) would pass an includes check yet slip past the === "abstain" test in combine
  const pick = a[fieldOf(q)];
  if (typeof pick !== "string" || !keys.includes(pick) || !exactKeys(a.probs, keys)) return false;
  // Weights may be unnormalized (they are normalized before averaging), but must be finite, non-negative and not all zero
  const w = keys.map((k) => a.probs[k]);
  return w.every((v) => Number.isFinite(v) && v >= 0) && w.some((v) => v > 0);
}

export function schemaOf(req) {
  const props = {};
  for (const q of req.questions) {
    if (q.type === "choice") {
      const keys = keysOf(q);
      props[q.id] = obj({ choice: { type: "string", enum: keys }, probs: probsOf(keys), evidence: TEXT, missing: TEXT });
    } else if (q.type === "bool") {
      props[q.id] = obj({ p_yes: { type: "number" }, abstain: { type: "boolean" }, evidence: TEXT, missing: TEXT });
    } else if (q.type === "score") {
      const keys = keysOf(q);
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
// CLI processes started for cold decisions. A caller that exits early (a hook past its deadline, a signal) must not
// leave one running with nobody left to time it out, so they are killed when this process exits.
const RUNNING = new Set();
// Each CLI runs in its own process group (not on Windows), so a launcher's children die with it instead of living on
const GROUPS = process.platform !== "win32";
const killTree = (child) => {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};
process.on("exit", () => {
  for (const child of RUNNING) killTree(child);
});

function run(cmd, args, { cwd, env, timeout }) {
  timeout = timeout > 0 ? timeout : 120_000;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: GROUPS });
    RUNNING.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => killTree(child), timeout);
    const settle = (code) => {
      clearTimeout(timer);
      RUNNING.delete(child);
      resolve({ code, out, err, ms: Math.round(performance.now() - t0) });
    };
    // Without an error listener a missing CLI (ENOENT) is an uncaught exception that takes the whole daemon down
    child.on("error", (e) => ((err += `${cmd}: ${e.message}`), settle(null)));
    child.on("close", settle);
  });
}

// ~/.cev holds every request in log.jsonl, so keep it private to the user
export function ensureHome() {
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const [path, mode] of [[HOME, 0o700], [LOG, 0o600]]) {
    try {
      chmodSync(path, mode); // tighten what older versions created with the default umask
    } catch {}
  }
}
export const appendLog = (entry) => {
  ensureHome();
  appendFileSync(LOG, JSON.stringify(entry) + "\n", { mode: 0o600 });
};

export function prepare() {
  ensureHome();
  const mcp = join(HOME, "empty-mcp.json");
  if (!existsSync(mcp)) writeFileSync(mcp, '{"mcpServers":{}}');
  writeFileSync(join(HOME, "system.md"), SYSTEM);
  return { mcp };
}

// Codex runs from its own home that shares only auth, without the user's hooks, plugins and memories.
// Only Codex paths call this, so a Claude-only setup never needs ~/.codex or symlink rights (Windows).
export function prepareCodex() {
  prepare();
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  // lstat, not existsSync: the link dangles when Codex isn't logged in, and re-linking it would throw EEXIST
  const auth = join(CODEX_HOME, "auth.json");
  const src = join(homedir(), ".codex", "auth.json");
  try {
    lstatSync(auth);
  } catch {
    try {
      symlinkSync(src, auth);
    } catch {
      if (existsSync(src)) copyFileSync(src, auth); // no symlink rights: a copy works until the login is refreshed
    }
  }
  writeFileSync(join(CODEX_HOME, "config.toml"), 'web_search = "disabled"\n');
}

export async function askClaude(req, { model, effort, timeout } = {}) {
  const cfg = claudeConfig();
  model ??= cfg.model;
  effort ??= cfg.effort;
  const { mcp } = prepare();
  const r = await run(
    "claude",
    ["-p", promptOf(req), "--model", model, "--tools", "", "--output-format", "json", "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp, "--system-prompt", SYSTEM, "--json-schema", JSON.stringify(schemaOf(req)), ...(effort ? ["--effort", effort] : [])],
    { cwd: RUN, timeout },
  );
  try {
    const j = JSON.parse(r.out);
    const u = Object.values(j.modelUsage ?? {})[0] ?? {};
    const tokensIn = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    const answer = j.structured_output ?? JSON.parse(j.result);
    // A non-zero exit is a failed call even if something parseable was printed
    return { ok: r.code === 0 && !j.is_error, answer, ms: r.ms, tokensIn, tokensOut: u.outputTokens ?? 0 };
  } catch (e) {
    return { ok: false, error: (r.err || r.out || String(e)).slice(0, 400), ms: r.ms, tokensIn: 0, tokensOut: 0 };
  }
}

export async function askCodex(req, { model = "gpt-6.1-sol", effort = "low", timeout } = {}) {
  prepareCodex();
  const schemaFile = join(RUN, `schema-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(schemaFile, JSON.stringify(schemaOf(req)));
  let r;
  try {
    r = await run(
      "codex",
      ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-m", model,
        "-c", `model_instructions_file="${join(HOME, "system.md")}"`, "-c", `model_reasoning_effort="${effort}"`,
        ...CODEX_OFF.flatMap((k) => ["-c", `${k}=false`]), "--output-schema", schemaFile, promptOf(req)],
      { cwd: RUN, env: { CODEX_HOME }, timeout },
    );
  } finally {
    rmSync(schemaFile, { force: true });
  }
  let answer = null;
  let usage = {};
  let completed = false;
  let failed = false;
  for (const line of r.out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") answer = ev.item.text;
    if (ev.type === "turn.completed") (usage = ev.usage ?? {}), (completed = true);
    if (ev.type === "turn.failed") failed = true;
    if (ev.type === "error" || ev.type === "turn.failed") r.err += JSON.stringify(ev);
  }
  try {
    // Only a completed turn from a cleanly exiting process counts; a message before a failure may be partial
    if (failed || !completed || r.code !== 0) throw new Error("codex turn did not complete");
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
    const vs = votes.map((v) => v?.[q.id]).filter((a) => validVote(q, a));
    const thr = thresholdOf(q.risk);
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
      const field = fieldOf(q);
      const keys = keysOf(q);
      // Average only the allowed keys, so a stray key in probs can never become the answer
      const dist = mean(vs.map((v) => normalize(Object.fromEntries(keys.map((k) => [k, v.probs[k]])))));
      // A model that chose abstain abstains, whatever weights it put on the options
      answer = vs.some((v) => v[field] === "abstain") ? "abstain" : argmax(dist);
      if (answer === "abstain") {
        conf = 0;
        agree = false;
      } else if (q.type === "score") {
        // The answer is one exact level, so every model must have picked that level and the confidence is the weight
        // on that level alone. Counting the neighbours' weight let a flat 0.33/0.34/0.33 answer with confidence 1.
        agree = vs.every((v) => Number(v[field]) === Number(answer));
        conf = dist[answer];
        answer = Number(answer);
      } else {
        // Agreement means every model picked the answer itself: probs that contradict the picks never authorize it
        agree = vs.every((v) => v[field] === answer);
        conf = dist[answer];
      }
    }
    const escalate = answer === "abstain" || !agree || vs.length < votes.length || conf < thr;
    answers[q.id] = { answer, conf: round2(conf), agree, escalate, why: evidence, ...(missing && { missing }) };
  }
  return answers;
}

// ── Entry point ──
export async function decide(req, { models, log = true, claude = {}, codex = {} } = {}) {
  checkRequest(req); // every entry point validates, not only the daemon
  models ??= route(req);
  const t0 = performance.now();
  const calls = await Promise.all(models.map((m) => (m === "claude" ? askClaude(req, claude) : askCodex(req, codex))));
  const byModel = Object.fromEntries(models.map((m, i) => [m, calls[i]]));
  const answers = combine(req, calls.map((c) => (c.ok ? c.answer : null)));
  const meta = {
    ms: Math.round(performance.now() - t0),
    models: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, { ok: c.ok, ms: c.ms, tokensIn: c.tokensIn, tokensOut: c.tokensOut, ...(c.error && { error: c.error }) }])),
  };
  const result = { answers, votes: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, c.ok ? c.answer : null])), meta };
  if (log) appendLog({ at: new Date().toISOString(), req, ...result });
  return result;
}
