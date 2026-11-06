#!/usr/bin/env node
// cev MCP bridge (stdio). Claude Code and Codex start one per session.
// It answers handshake and tool listing itself and forwards only decisions to the shared daemon (core/daemon.mjs).
// The daemon is started on the first decision, outlives the session, and exits by itself when idle.
//   claude mcp add --scope user cev -- node /path/to/cev/cli/mcp.mjs
//   codex mcp add cev -- node /path/to/cev/cli/mcp.mjs
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "../core/cev.mjs";
import { TOOL, INSTRUCTIONS, VERSION, toolResult, toolError, protocolOf } from "../core/tool.mjs";

const BASE = `http://127.0.0.1:${process.env.CEV_PORT ?? 7767}`;
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon.mjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let client = "unknown";

const health = () => fetch(`${BASE}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// A daemon from another cev version keeps answering after an upgrade (it outlives sessions), so replace it once it
// is idle. While it is busy for other sessions, use it as is rather than cut their decisions off.
async function retireStale() {
  const h = await health();
  if (!h || h.version === VERSION) return;
  const r = await fetch(`${BASE}/retire`, { method: "POST" }).catch(() => null);
  if (r?.status === 409) return; // busy: it decides atomically, try again next session
  if (r?.status === 404) {
    // 0.3.x has no /retire. Signal only something that answers exactly like an idle cev daemon,
    // and never pid 0/1 or a negative pid (those address process groups)
    const legacy = h.ok === true && typeof h.version === "string" && /^0\.[0-3]\./.test(h.version) && h.inflight === 0 && h.queued === 0 && Number.isInteger(h.pid) && h.pid > 1;
    if (!legacy) return;
    try {
      process.kill(h.pid, "SIGTERM");
    } catch {
      return;
    }
  } else if (!r?.ok) return;
  for (let i = 0; i < 25 && (await health()); i++) await pause(200);
}

async function ensureDaemon() {
  await retireStale();
  if (await health()) return;
  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "daemon.log"), "a");
  // Detached so it outlives this session for others to use. If several sessions race, whoever binds the port wins.
  spawn(process.execPath, [DAEMON], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i++) {
    await pause(200);
    if (await health()) return;
  }
  throw new Error(`cev server did not start, see ${join(HOME, "daemon.log")}`);
}

async function decide(args) {
  // If the daemon was exiting just as we called, start a new one and retry once
  for (let attempt = 0; ; attempt++) {
    await ensureDaemon();
    let r;
    try {
      r = await fetch(`${BASE}/decide?client=${encodeURIComponent(client)}&session=${process.pid}`, { method: "POST", body: JSON.stringify(args) });
    } catch (e) {
      if (attempt) throw e;
      continue;
    }
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    return body;
  }
}

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      client = msg.params?.clientInfo?.name ?? client;
      return reply({ protocolVersion: protocolOf(msg.params?.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: "cev", version: VERSION }, instructions: INSTRUCTIONS });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call":
      if (msg.params?.name !== TOOL.name) return fail(-32602, `unknown tool ${msg.params?.name}`);
      try {
        return reply(toolResult(await decide(msg.params.arguments)));
      } catch (e) {
        return reply(toolError(e));
      }
    default:
      if (msg.id != null) fail(-32601, `method not found: ${msg.method}`);
  }
});
