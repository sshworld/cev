#!/usr/bin/env node
// cev daemon: one warm decider shared by every session.
// - Nothing to install. The per-session bridge (cli/mcp.mjs) starts it on the first decision, and it exits after sitting idle.
// - Listens on 127.0.0.1 only. If the port is taken (another daemon is already up), it exits quietly.
// - POST /decide  a decision (used by the bridge and the CLI)
// - POST /mcp     MCP over Streamable HTTP (JSON responses only), for clients that connect by URL
// - GET  /health  pool state, queue and counters
// - POST /retire  exit if idle (a bridge of another version replaces the daemon this way)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { route, checkRequest, codexEnabled, claudeConfig, appendLog, ensureHome } from "./cev.mjs";
import { warmDecider } from "./warm.mjs";
import { VERSION, PROTOCOLS, handleMcp, parseError } from "./tool.mjs";

const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env("CEV_PORT", 7767));
const CONCURRENCY = Math.max(1, Number(env("CEV_CONCURRENCY", 4)) || 1); // 0 would queue every decision forever
const MAX_QUEUE = Math.max(0, Number(env("CEV_MAX_QUEUE", 32)) || 0);
const MAX_BODY = 1 << 20; // a decision is a few KB; refuse anything that would only fill memory
const CODEX = codexEnabled();
const IDLE_MS = Number(env("CEV_IDLE_MIN", 30)) * 60_000;
const MAX_AGE_MS = Number(env("CEV_MAX_AGE_H", 6)) * 3_600_000; // respawn the pool now and then to pick up CLI updates and refreshed auth

let decider = null; // created only after the port is ours, so racing daemons don't each spawn a pool
let awakeSince = Date.now();
let lastUsed = Date.now();
const stats = { served: 0, failed: 0, fallbacks: 0, startedAt: new Date().toISOString() };

// ── Concurrency cap: queue whatever exceeds the pool ──
let inflight = 0;
const queue = [];
const acquire = () => (inflight < CONCURRENCY ? (inflight++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const release = () => (queue.length ? queue.shift()() : inflight--);

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function decideShared(req, caller) {
  checkRequest(req);
  if (inflight >= CONCURRENCY && queue.length >= MAX_QUEUE) throw httpError(503, `cev busy: ${queue.length} decisions queued, try again shortly`);
  const tq = performance.now();
  await acquire();
  const waitMs = Math.round(performance.now() - tq);
  try {
    if (!decider.awake()) awakeSince = Date.now();
    lastUsed = Date.now();
    const models = route(req, { codex: CODEX });
    const r = await decider.decide(req, { models });
    stats.served++;
    stats.fallbacks += Object.values(r.meta.models).filter((m) => m.via === "cold").length;
    r.meta.waitMs = waitMs;
    appendLog({ at: new Date().toISOString(), caller, req, ...r });
    return r;
  } catch (e) {
    stats.failed++;
    throw e;
  } finally {
    lastUsed = Date.now();
    release();
  }
}

// Exit entirely after sitting idle (the bridge starts a new daemon on the next decision).
// After a long uptime, drop the pool while it's empty so the next decision gets fresh CLI processes.
setInterval(() => {
  if (inflight) return;
  if (Date.now() - lastUsed > IDLE_MS) {
    console.error(`cev: idle ${Math.round((Date.now() - lastUsed) / 60_000)}m, exiting`);
    decider.close();
    process.exit(0);
  }
  if (decider.awake() && Date.now() - awakeSince > MAX_AGE_MS) decider.sleep();
}, 60_000).unref();

// ── MCP ──
// Mcp-Session-Id → who connected. Bounded: the oldest sessions are forgotten first, and a client that sends a
// forgotten or deleted id gets 404 and starts over with initialize, as the Streamable HTTP transport specifies.
const MAX_SESSIONS = 256;
const sessions = new Map();
const remember = (sid, info) => {
  sessions.set(sid, info);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
};

// ── HTTP ──
const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let over = false;
    req.on("data", (d) => {
      if (over) return; // keep draining so the 413 still reaches the client
      bytes += d.length; // bytes, not string length: multi-byte text would otherwise slip past
      if (bytes > MAX_BODY) (over = true), (chunks.length = 0), reject(httpError(413, "request body too large"));
      else chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(obj == null ? "" : JSON.stringify(obj));
};
// Reject other origins so a web page can't drive the local daemon (DNS rebinding)
const localOrigin = (o) => !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);

const server = createServer(async (req, res) => {
  try {
    if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
    const url = new URL(req.url, "http://127.0.0.1"); // inside try: a malformed target must not take the daemon down
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, codex: CODEX, claude: CLAUDE, awake: decider.awake(), codexTier: decider.codexTier(), inflight, queued: queue.length, sessions: sessions.size, ...stats });
    }
    // A bridge of another cev version asks an idle daemon to step aside. The idle check and the exit happen here,
    // in one tick, so no decision can slip in between (a SIGTERM from outside could cut one off).
    if (req.method === "POST" && url.pathname === "/retire") {
      if (inflight || queue.length) return send(res, 409, { error: "busy" });
      send(res, 200, { ok: true });
      decider.close();
      server.close();
      return setImmediate(() => process.exit(0));
    }
    if (req.method === "POST" && url.pathname === "/decide") {
      const r = await decideShared(JSON.parse(await body(req)), { via: "http", tag: url.searchParams.get("client") ?? "cli", session: url.searchParams.get("session") ?? undefined });
      return send(res, 200, r);
    }
    if (url.pathname === "/mcp") {
      if (req.method === "GET") return send(res, 405, null, { allow: "POST, DELETE" }); // no server-initiated messages, so no SSE stream
      const sid = req.headers["mcp-session-id"];
      if (req.method === "DELETE") return send(res, sid && sessions.delete(sid) ? 200 : 404, null);
      if (req.method !== "POST") return send(res, 405, null, { allow: "POST, DELETE" });
      const pv = req.headers["mcp-protocol-version"];
      if (pv && !PROTOCOLS.includes(pv)) return send(res, 400, { error: `unsupported MCP-Protocol-Version ${pv}` });
      let parsed;
      try {
        parsed = JSON.parse(await body(req));
      } catch (e) {
        if (e.status) throw e;
        return send(res, 400, parseError());
      }
      const msgs = Array.isArray(parsed) && parsed.length ? parsed : [parsed];
      const initializing = msgs.some((m) => m?.method === "initialize");
      if (sid && !initializing && !sessions.has(sid)) return send(res, 404, { error: "unknown or expired session, initialize again" });
      let newSession;
      const caller = () => ({ via: "mcp", session: sid ?? newSession, ...(sessions.get(sid ?? newSession) ?? { tag: url.searchParams.get("client") }) });
      const onInitialize = (p) => {
        newSession = randomUUID();
        remember(newSession, { client: p.clientInfo?.name, tag: url.searchParams.get("client") });
      };
      const replies = await Promise.all(msgs.map((m) => handleMcp(m, { decide: (args) => decideShared(args, caller()), onInitialize })));
      const headers = newSession ? { "mcp-session-id": newSession } : {};
      const sent = replies.filter(Boolean);
      if (!sent.length) return send(res, 202, null, headers);
      return send(res, 200, Array.isArray(parsed) && parsed.length ? sent : sent[0], headers);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.status ?? 400, { error: String(e.message ?? e) });
  }
});

ensureHome();
const CLAUDE = claudeConfig(); // a bad CEV_CLAUDE_MODEL / CEV_CLAUDE_EFFORT stops the daemon here, before it listens
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`cev: port ${PORT} already in use, another daemon is running`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  decider = warmDecider({ pool: Number(env("CEV_POOL", 2)), serviceTier: env("CEV_TIER", "priority") || undefined, codex: CODEX, claudeModel: CLAUDE.model, claudeEffort: CLAUDE.effort });
  console.error(`cev ${VERSION} listening on 127.0.0.1:${PORT} (pid ${process.pid}, ${CODEX ? "Claude + Codex" : "Claude only"})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    decider?.close();
    server.close();
    process.exit(0);
  });
}
