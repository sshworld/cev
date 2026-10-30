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
import { TOOL, INSTRUCTIONS, VERSION, toolResult, toolError } from "../core/tool.mjs";

const BASE = `http://127.0.0.1:${process.env.CEV_PORT ?? 7767}`;
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon.mjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let client = "unknown";

const alive = () => fetch(`${BASE}/health`).then((r) => r.ok, () => false);

async function ensureDaemon() {
  if (await alive()) return;
  mkdirSync(HOME, { recursive: true });
  const log = openSync(join(HOME, "daemon.log"), "a");
  // Detached so it outlives this session for others to use. If several sessions race, whoever binds the port wins.
  spawn(process.execPath, [DAEMON], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i++) {
    await pause(200);
    if (await alive()) return;
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
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cev", version: VERSION }, instructions: INSTRUCTIONS });
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
