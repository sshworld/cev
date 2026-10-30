// Warm mode: keep the CLIs running so a decision only has to send the question.
// - Claude: a pool of pre-started `claude -p --input-format stream-json` processes. Each serves one decision and is discarded, so conversations never mix.
// - Codex: one long-lived `codex app-server`, with a fresh (pre-opened) thread per decision.
// - If a warm process died or returned a broken answer, that model alone is asked again cold.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { HOME, SYSTEM, schemaOf, promptOf, combine, prepare, askClaude, askCodex, CODEX_HOME, CODEX_OFF } from "./cev.mjs";

const RUN = join(HOME, "run");

// ── Claude pool ──
class ClaudeProc {
  constructor({ model }) {
    const { mcp } = prepare();
    this.child = spawn(
      "claude",
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--no-session-persistence",
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp, "--system-prompt", SYSTEM],
      { cwd: RUN, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.dead = false;
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.waiters = [];
    this.lines.on("line", (line) => {
      if (!line.startsWith("{")) return;
      const ev = JSON.parse(line);
      if (ev.type === "result") this.waiters.shift()?.(ev);
    });
    this.child.on("close", () => {
      this.dead = true;
      this.waiters.splice(0).forEach((w) => w(null));
    });
  }
  ask(req, { timeout }) {
    // --json-schema is per process, so in warm mode the schema rides in the prompt and the answer is validated here
    const text = `${promptOf(req)}\n\nReply with one JSON object matching this JSON Schema exactly:\n${JSON.stringify(schemaOf(req))}`;
    return new Promise((resolve) => {
      const t0 = performance.now();
      if (this.dead) return resolve({ ok: false, error: "claude exited before use", ms: 0, tokensIn: 0, tokensOut: 0 });
      const timer = setTimeout(() => this.child.kill("SIGKILL"), timeout);
      this.waiters.push((ev) => {
        clearTimeout(timer);
        const ms = Math.round(performance.now() - t0);
        this.child.stdin.end();
        if (!ev) return resolve({ ok: false, error: "claude exited", ms, tokensIn: 0, tokensOut: 0 });
        const u = Object.values(ev.modelUsage ?? {})[0] ?? {};
        const tokensIn = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
        try {
          const answer = JSON.parse(String(ev.result).replace(/^```(?:json)?\s*|\s*```$/g, ""));
          const ok = !ev.is_error && validate(req, answer);
          resolve({ ok, answer, ms, tokensIn, tokensOut: u.outputTokens ?? 0, ...(!ok && { error: "invalid answer shape" }) });
        } catch (e) {
          resolve({ ok: false, error: String(ev.result).slice(0, 300), ms, tokensIn, tokensOut: u.outputTokens ?? 0 });
        }
      });
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }
  kill() {
    this.child.kill();
  }
}

// The schema can't be enforced on this path, so check the required fields and shapes by hand
function validate(req, answer) {
  return req.questions.every((q) => {
    const a = answer?.[q.id];
    if (!a) return false;
    if (q.type === "bool") return typeof a.p_yes === "number";
    const field = q.type === "choice" ? "choice" : "score";
    return a[field] != null && a.probs && typeof a.probs === "object";
  });
}

// ── Codex app-server ──
class CodexServer {
  constructor({ model, effort, serviceTier }) {
    prepare();
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
    // If the server dies, fail every pending request and turn so they fall back to cold
    this.child.on("close", () => {
      this.dead = true;
      this.pending.forEach(({ reject }) => reject(new Error("codex app-server exited")));
      this.pending.clear();
      this.turns.forEach((t) => ((t.error ??= "codex app-server exited"), t.done()));
    });
    this.ready = this.request("initialize", { clientInfo: { name: "cev", title: "cev", version: "0.1.0" }, capabilities: null }).then(() => this.notify("initialized"));
    this.ready.catch(() => {});
    this.spare = [];
  }
  onLine(line) {
    if (!line.startsWith("{")) return;
    const msg = JSON.parse(line);
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
    if (msg.method === "turn/completed") turn.done();
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
    const turn = { text: null, usage: null, error: null };
    try {
      const threadId = await (this.spare.shift() ?? this.thread());
      this.warm(1);
      const finished = new Promise((resolve) => (turn.done = resolve));
      this.turns.set(threadId, turn);
      const timer = setTimeout(() => ((turn.error = `timeout ${timeout}ms`), turn.done()), timeout);
      await this.request("turn/start", { threadId, input: [{ type: "text", text: promptOf(req), text_elements: [] }], outputSchema: schemaOf(req), effort: this.effort });
      await finished;
      clearTimeout(timer);
      this.turns.delete(threadId);
    } catch (e) {
      turn.error ??= String(e.message ?? e);
    }
    const ms = Math.round(performance.now() - t0);
    const u = turn.usage ?? {};
    try {
      if (turn.error && !turn.text) throw new Error(turn.error);
      return { ok: true, answer: JSON.parse(turn.text), ms, tokensIn: u.inputTokens ?? 0, tokensOut: (u.outputTokens ?? 0) + (u.reasoningOutputTokens ?? 0) };
    } catch {
      return { ok: false, error: turn.error ?? String(turn.text).slice(0, 300), ms, tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0 };
    }
  }
  kill() {
    this.child.kill();
  }
}

// ── Warm decider ──
// sleep() tears the pool down to free memory; the next decision brings it back.
export function warmDecider({ claudeModel = "opus", codexModel = "gpt-6.1-sol", effort = "low", serviceTier, pool = 2, timeout = 90_000, fallback = true } = {}) {
  let claudes = [];
  let codex = null;
  let awake = false;
  const newCodex = () => {
    codex = new CodexServer({ model: codexModel, effort, serviceTier });
    codex.warm(pool);
  };
  const fill = () => {
    claudes = claudes.filter((p) => !p.dead);
    while (claudes.length < pool) claudes.push(new ClaudeProc({ model: claudeModel }));
  };
  const wake = () => {
    if (awake) return;
    awake = true;
    fill();
    newCodex();
  };
  wake();

  async function ask(m, req) {
    wake();
    let r;
    if (m === "codex") {
      if (codex.dead) newCodex();
      r = await codex.ask(req, { timeout });
    } else {
      claudes = claudes.filter((p) => !p.dead);
      const proc = claudes.shift() ?? new ClaudeProc({ model: claudeModel });
      fill();
      r = await proc.ask(req, { timeout });
    }
    if (r.ok || !fallback) return { ...r, via: "warm" };
    const c = m === "codex" ? await askCodex(req, { model: codexModel, effort }) : await askClaude(req, { model: claudeModel });
    return { ...c, via: "cold", warmError: r.error };
  }

  return {
    async decide(req, { models = ["claude", "codex"] } = {}) {
      const t0 = performance.now();
      const calls = await Promise.all(models.map((m) => ask(m, req)));
      const byModel = Object.fromEntries(models.map((m, i) => [m, calls[i]]));
      return {
        answers: combine(req, calls.map((c) => (c.ok ? c.answer : null))),
        votes: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, c.ok ? c.answer : null])),
        meta: {
          ms: Math.round(performance.now() - t0),
          models: Object.fromEntries(Object.entries(byModel).map(([m, c]) => [m, { ok: c.ok, ms: c.ms, via: c.via, tokensIn: c.tokensIn, tokensOut: c.tokensOut, ...(c.error && { error: c.error }), ...(c.warmError && { warmError: c.warmError }) }])),
        },
      };
    },
    codexTier: () => codex?.tier,
    awake: () => awake,
    sleep() {
      if (!awake) return;
      awake = false;
      claudes.splice(0).forEach((p) => p.kill());
      codex?.kill();
      codex = null;
    },
    close() {
      this.sleep();
    },
  };
}
