// Warm mode: keep the CLIs running so a decision only has to send the question.
// - Claude: a pool of pre-started `claude -p --input-format stream-json` processes. Each serves one decision and is discarded, so conversations never mix.
// - Codex: one long-lived `codex app-server`, with a fresh (pre-opened) thread per decision.
// - If a warm process died or returned a broken answer, that model alone is asked again cold.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { HOME, SYSTEM, schemaOf, promptOf, combine, prepare, prepareCodex, askClaude, askCodex, validVote, codexEnabled, claudeConfig, CODEX_HOME, CODEX_OFF } from "./cev.mjs";

const RUN = join(HOME, "run");

// ── Claude pool ──
// Every Claude child still running, pooled or not, so shutdown can reach the ones already handed out
const LIVE = new Set();
// A finished process normally exits within ~1s of stdin closing; one that lingers is killed so it can't pile up
const EXIT_GRACE_MS = 5_000;

class ClaudeProc {
  constructor({ model, effort, onModel }) {
    const { mcp } = prepare();
    this.child = spawn(
      "claude",
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--no-session-persistence",
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp, "--system-prompt", SYSTEM, ...(effort ? ["--effort", effort] : [])],
      { cwd: RUN, stdio: ["pipe", "pipe", "pipe"], detached: GROUPS },
    );
    this.dead = false;
    LIVE.add(this);
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.waiters = [];
    this.lines.on("line", (line) => {
      if (!line.startsWith("{")) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      // The CLI names the model an alias resolved to when it gets its first request: replay keys on it, so a moved alias misses
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") (this.model = ev.model), onModel?.(ev.model);
      if (ev.type === "result") this.waiters.shift()?.(ev);
    });
    // "error" covers a CLI that failed to start (ENOENT); unhandled, it would crash the daemon
    this.exited = () => {
      if (this.dead) return;
      this.dead = true;
      LIVE.delete(this);
      this.waiters.splice(0).forEach((w) => w(null));
    };
    this.child.on("error", this.exited);
    this.child.on("close", this.exited);
  }
  // The whole process group, so nothing the CLI started outlives it holding the pipes open (not on Windows)
  killTree() {
    try {
      if (GROUPS && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }
  // The answer is taken from the result event (its is_error is the CLI's own success signal) without waiting
  // ~0.8s for the exit; the process is then told to finish and killed if it doesn't.
  finish() {
    this.child.stdin.end();
    setTimeout(() => !this.dead && this.killTree(), EXIT_GRACE_MS).unref();
  }
  ask(req, { timeout }) {
    // --json-schema is per process, so in warm mode the schema rides in the prompt and the answer is validated here
    const text = `${promptOf(req)}\n\nReply with one JSON object matching this JSON Schema exactly:\n${JSON.stringify(schemaOf(req))}`;
    return new Promise((resolve) => {
      const t0 = performance.now();
      if (this.dead) return resolve({ ok: false, error: "claude exited before use", ms: 0, tokensIn: 0, tokensOut: 0 });
      // On timeout the call is settled here: waiting for "close" would hang if a surviving child kept the pipes open
      const timer = setTimeout(() => (this.killTree(), this.exited()), timeout);
      this.waiters.push((ev) => {
        clearTimeout(timer);
        const ms = Math.round(performance.now() - t0);
        this.finish();
        if (!ev) return resolve({ ok: false, error: "claude exited", ms, tokensIn: 0, tokensOut: 0 });
        const u = Object.values(ev.modelUsage ?? {})[0] ?? {};
        const tokensIn = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
        try {
          const answer = JSON.parse(String(ev.result).replace(/^```(?:json)?\s*|\s*```$/g, ""));
          const ok = !ev.is_error && validate(req, answer);
          resolve({ ok, answer, ms, tokensIn, tokensOut: u.outputTokens ?? 0, model: Object.keys(ev.modelUsage ?? {})[0] ?? this.model, ...(!ok && { error: "invalid answer shape" }) });
        } catch (e) {
          resolve({ ok: false, error: String(ev.result).slice(0, 300), ms, tokensIn, tokensOut: u.outputTokens ?? 0 });
        }
      });
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }
  kill() {
    this.killTree();
    this.exited();
  }
}

const GROUPS = process.platform !== "win32";
// Warm processes have their own process groups, so they don't die with this one by themselves: whatever way it
// exits (a crash included), take them along.
process.on("exit", () => LIVE.forEach((p) => p.killTree()));
const COLD_BUDGET_MS = 8000; // a cold call takes about 3s, sometimes much more: below this a retry would only overrun

// The schema can't be enforced on this path, so check every answer by hand (combine checks again per vote)
// An answer with a field no question asked for is malformed as a whole, even if the votes in it look fine
const validate = (req, answer) => {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return false;
  const ids = new Set(req.questions.map((q) => q.id));
  return Object.keys(answer).every((k) => ids.has(k)) && req.questions.every((q) => validVote(q, answer[q.id]));
};

// ── Codex app-server ──
class CodexServer {
  constructor({ model, effort, serviceTier }) {
    prepareCodex();
    this.model = model;
    this.serviceTier = serviceTier;
    this.effort = effort;
    this.dead = false;
    this.child = spawn("codex", ["app-server", ...CODEX_OFF.flatMap((k) => ["-c", `${k}=false`])], { cwd: RUN, env: { ...process.env, CODEX_HOME }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {});
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    // If the server dies (or never started), fail every pending request and turn so they fall back to cold
    const exited = () => {
      this.dead = true;
      this.pending.forEach(({ reject }) => reject(new Error("codex app-server exited")));
      this.pending.clear();
      this.turns.forEach((t) => ((t.error ??= "codex app-server exited"), t.done()));
    };
    this.child.on("error", exited);
    this.child.on("close", exited);
    this.ready = this.request("initialize", { clientInfo: { name: "cev", title: "cev", version: "0.1.0" }, capabilities: null }).then(() => this.notify("initialized"));
    this.ready.catch(() => {});
    this.spare = [];
  }
  onLine(line) {
    if (!line.startsWith("{")) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
    if (msg.id != null && msg.method) return this.send({ id: msg.id, result: { decision: "decline" } }); // decline every approval request
    const p = msg.params ?? {};
    const turn = this.turns.get(p.threadId);
    if (!turn) return;
    if (msg.method === "item/completed" && p.item?.type === "agentMessage") turn.text = p.item.text;
    if (msg.method === "thread/tokenUsage/updated") turn.usage = p.tokenUsage.last;
    // A failed or interrupted turn also "completes"; only an explicit status completed means the answer is final
    if (msg.method === "turn/completed") (turn.completed = p.turn?.status === "completed"), turn.done();
    if (msg.method === "error") turn.error = JSON.stringify(p).slice(0, 300);
  }
  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params) {
    if (this.dead) return Promise.reject(new Error("codex app-server exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  notify(method) {
    this.send({ method });
  }
  async thread() {
    await this.ready;
    const r = await this.request("thread/start", { model: this.model, cwd: RUN, approvalPolicy: "never", sandbox: "read-only", baseInstructions: SYSTEM, ephemeral: true, ...(this.serviceTier && { serviceTier: this.serviceTier }) });
    this.tier = r.serviceTier;
    return r.thread.id;
  }
  warm(n = 1) {
    while (this.spare.length < n) {
      const t = this.thread();
      t.catch(() => {});
      this.spare.push(t);
    }
  }
  async ask(req, { timeout }) {
    const t0 = performance.now();
    const turn = { text: null, usage: null, error: null, done: () => {} };
    // One deadline over the whole ask: a server that is alive but stuck in initialize, thread/start or turn/start
    // would otherwise hold a concurrency slot forever
    let timer;
    let threadId;
    const deadline = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout ${timeout}ms`)), timeout)));
    const work = (async () => {
      threadId = await (this.spare.shift() ?? this.thread());
      this.warm(1);
      if (turn.closed) return;
      const finished = new Promise((resolve) => (turn.done = resolve));
      this.turns.set(threadId, turn);
      const started = await this.request("turn/start", { threadId, input: [{ type: "text", text: promptOf(req), text_elements: [] }], outputSchema: schemaOf(req), effort: this.effort });
      turn.started = true;
      turn.id = started?.turn?.id;
      if (turn.closed) return this.interrupt(threadId, turn); // the deadline fired while turn/start was in flight
      await finished;
    })();
    work.catch(() => {});
    try {
      await Promise.race([work, deadline]);
    } catch (e) {
      turn.error ??= String(e.message ?? e);
    } finally {
      clearTimeout(timer);
      turn.closed = true;
      if (threadId) this.turns.delete(threadId);
    }
    if (turn.error && !this.dead) {
      // Timed out before the turn even started: the server is stuck, not slow. Retire it (its other waiters fail
      // over to cold) so later asks don't pile up behind it; the next ask starts a fresh one.
      if (!turn.started) this.kill();
      // Timed out mid-turn: stop it, so it doesn't keep running beside the cold retry outside the concurrency cap
      else this.interrupt(threadId, turn);
    }
    const ms = Math.round(performance.now() - t0);
    const u = turn.usage ?? {};
    try {
      // Only a completed turn counts: text that arrived before a timeout or an error may be a partial answer
      if (turn.error || !turn.completed) throw new Error(turn.error ?? "turn did not complete");
      const answer = JSON.parse(turn.text);
      // An answer of the wrong shape is a failed warm call, so it gets the cold retry like any other failure
      if (!validate(req, answer)) throw new Error("invalid answer shape");
      return { ok: true, answer, ms, tokensIn: u.inputTokens ?? 0, tokensOut: (u.outputTokens ?? 0) + (u.reasoningOutputTokens ?? 0) };
    } catch (e) {
      return { ok: false, error: turn.error ?? `${e.message}: ${String(turn.text).slice(0, 300)}`, ms, tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0 };
    }
  }
  interrupt(threadId, turn) {
    if (!turn.id || turn.interrupted || this.dead) return;
    turn.interrupted = true;
    this.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => {});
  }
  kill() {
    this.child.kill();
  }
}

// ── Warm decider ──
// sleep() tears the pool down to free memory; the next decision brings it back.
// Codex is started only when it is enabled or first asked, so a Claude-only setup never pays for an app-server.
export function warmDecider({ claudeModel = claudeConfig().model, claudeEffort = claudeConfig().effort, codexModel = "gpt-6.1-sol", effort = "low", serviceTier, pool = 2, timeout: defaultTimeout = 90_000, fallback = true, codex: useCodex = codexEnabled() } = {}) {
  let claudes = [];
  // The model id the newest Claude process reported. Every process is started with the same alias, so the latest
  // report is what the alias resolves to now; a moved alias shows up with the next process that starts.
  let known = null;
  const onModel = (id) => (known = id);
  let codex = null;
  let awake = false;
  const newCodex = () => {
    codex = new CodexServer({ model: codexModel, effort, serviceTier });
    codex.warm(pool);
  };
  const fill = () => {
    claudes = claudes.filter((p) => !p.dead);
    while (claudes.length < pool) claudes.push(new ClaudeProc({ model: claudeModel, effort: claudeEffort, onModel }));
  };
  const wake = () => {
    if (awake) return;
    awake = true;
    fill();
    if (useCodex) newCodex();
  };
  wake();

  // deadlineAt (a performance.now() value) bounds this one decision: the warm call gets what is left of it, and a
  // cold retry is made only when enough is left for one (COLD_BUDGET_MS), otherwise the failure stands and escalates.
  async function ask(m, req, deadlineAt) {
    wake();
    const left = () => (deadlineAt === undefined ? Infinity : deadlineAt - performance.now());
    if (left() <= 0) return { ok: false, error: "deadline passed", ms: 0, tokensIn: 0, tokensOut: 0, via: "none" };
    const timeout = Math.min(defaultTimeout, left());
    let r;
    if (m === "codex") {
      if (!codex || codex.dead) newCodex();
      r = await codex.ask(req, { timeout });
    } else {
      claudes = claudes.filter((p) => !p.dead);
      const proc = claudes.shift() ?? new ClaudeProc({ model: claudeModel, effort: claudeEffort, onModel });
      try {
        fill();
      } catch (e) {
        proc.kill(); // the replacement couldn't be started (disk full, no permission): don't strand the one taken out
        throw e;
      }
      r = left() <= 0 ? { ok: false, error: "deadline passed", ms: 0, tokensIn: 0, tokensOut: 0 } : await proc.ask(req, { timeout: Math.min(defaultTimeout, left()) });
      if (!r.ok && !proc.dead) proc.kill();
    }
    if (r.ok || !fallback || left() < COLD_BUDGET_MS) return { ...r, via: "warm" };
    const cold = { timeout: Math.min(120_000, left()) };
    const c = m === "codex" ? await askCodex(req, { model: codexModel, effort, ...cold }) : await askClaude(req, { model: claudeModel, effort: claudeEffort, ...cold });
    return { ...c, via: "cold", warmError: r.error };
  }

  return {
    async decide(req, { models = useCodex ? ["claude", "codex"] : ["claude"], deadlineAt } = {}) {
      const t0 = performance.now();
      const calls = await Promise.all(models.map((m) => ask(m, req, deadlineAt)));
      const byModel = Object.fromEntries(models.map((m, i) => [m, calls[i]]));
      return {
        answers: combine(req, calls.map((c) => (c.ok ? c.answer : null))),
        votes: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, c.ok ? c.answer : null])),
        meta: {
          ms: Math.round(performance.now() - t0),
          models: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, { ok: c.ok, ms: c.ms, via: c.via, tokensIn: c.tokensIn, tokensOut: c.tokensOut, ...(c.model && { model: c.model }), ...(c.error && { error: c.error }), ...(c.warmError && { warmError: c.warmError }) }])),
        },
      };
    },
    // The model warm Claude answers with, once a process has reported it
    identity: () => known,
    codexTier: () => codex?.tier,
    awake: () => awake,
    sleep() {
      if (!awake) return;
      awake = false;
      known = null; // the next pool may resolve the alias to another model: learn it again before replaying
      claudes.splice(0);
      LIVE.forEach((p) => p.kill()); // pooled and in-use alike
      codex?.kill();
      codex = null;
    },
    close() {
      this.sleep();
    },
  };
}
