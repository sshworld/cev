#!/usr/bin/env node
// cev daemon: one warm decider shared by every session.
// - Nothing to install. The per-session bridge (cli/mcp.mjs) starts it on the first decision, and it exits after sitting idle.
// - Listens on 127.0.0.1 only. If the port is taken (another daemon is already up), it exits quietly.
// - POST /decide  a decision (used by the bridge and the CLI)
// - POST /mcp     MCP over Streamable HTTP (JSON responses only), for clients that connect by URL
// - GET  /health  pool state, queue and counters
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { HOME, LOG, route, checkRequest } from "./cev.mjs";
import { warmDecider } from "./warm.mjs";
import { TOOL, INSTRUCTIONS, VERSION, toolResult, toolError } from "./tool.mjs";

const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env("CEV_PORT", 7767));
const CONCURRENCY = Number(env("CEV_CONCURRENCY", 4));
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

async function decideShared(req, caller) {
  checkRequest(req);
  const tq = performance.now();
  await acquire();
  const waitMs = Math.round(performance.now() - tq);
  try {
    if (!decider.awake()) awakeSince = Date.now();
    lastUsed = Date.now();
    const models = route(req);
    const r = await decider.decide(req, { models });
    stats.served++;
    stats.fallbacks += Object.values(r.meta.models).filter((m) => m.via === "cold").length;
    r.meta.waitMs = waitMs;
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), caller, req, ...r }) + "\n");
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
const sessions = new Map(); // Mcp-Session-Id → who connected (unknown ids after a restart are still accepted)

async function mcp(msg, ctx) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      ctx.newSession = randomUUID();
      sessions.set(ctx.newSession, { client: msg.params?.clientInfo?.name, tag: ctx.tag });
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cev", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return fail(-32602, `unknown tool ${msg.params?.name}`);
      try {
        return reply(toolResult(await decideShared(msg.params.arguments, ctx.caller())));
      } catch (e) {
        return reply(toolError(e));
      }
    }
    default:
      return msg.id == null ? null : fail(-32601, `method not found: ${msg.method}`);
  }
}

// ── HTTP ──
const body = (req) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(obj == null ? "" : JSON.stringify(obj));
};
// Reject other origins so a web page can't drive the local daemon (DNS rebinding)
const localOrigin = (o) => !o || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, awake: decider.awake(), codexTier: decider.codexTier(), inflight, queued: queue.length, sessions: sessions.size, ...stats });
    }
    if (req.method === "POST" && url.pathname === "/decide") {
      const r = await decideShared(JSON.parse(await body(req)), { via: "http", tag: url.searchParams.get("client") ?? "cli", session: url.searchParams.get("session") ?? undefined });
      return send(res, 200, r);
    }
    if (url.pathname === "/mcp") {
      if (req.method === "GET") return send(res, 405, null, { allow: "POST, DELETE" }); // no server-initiated messages, so no SSE stream
      if (req.method === "DELETE") return sessions.delete(req.headers["mcp-session-id"]), send(res, 200, null);
      if (req.method !== "POST") return send(res, 405, null);
      const sid = req.headers["mcp-session-id"];
      const ctx = { tag: url.searchParams.get("client"), caller: () => ({ via: "mcp", session: sid, ...(sessions.get(sid) ?? { tag: url.searchParams.get("client") }) }) };
      const parsed = JSON.parse(await body(req));
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const replies = (await Promise.all(msgs.map((m) => mcp(m, ctx)))).filter(Boolean);
      const headers = ctx.newSession ? { "mcp-session-id": ctx.newSession } : {};
      if (!replies.length) return send(res, 202, null, headers);
      return send(res, 200, Array.isArray(parsed) ? replies : replies[0], headers);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: String(e.message ?? e) });
  }
});

mkdirSync(HOME, { recursive: true });
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`cev: port ${PORT} already in use, another daemon is running`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  decider = warmDecider({ pool: Number(env("CEV_POOL", 2)), serviceTier: env("CEV_TIER", "priority") || undefined });
  console.error(`cev ${VERSION} listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    decider?.close();
    server.close();
    process.exit(0);
  });
}
