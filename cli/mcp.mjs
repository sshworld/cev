#!/usr/bin/env node
// cev MCP bridge (stdio). Claude Code and Codex start one per session.
// It answers handshake and tool listing itself and forwards only decisions to the shared daemon (core/daemon.mjs).
// The daemon is started on the first decision, outlives the session, and exits by itself when idle.
//   claude mcp add --scope user cev -- node /path/to/cev/cli/mcp.mjs
//   codex mcp add cev -- node /path/to/cev/cli/mcp.mjs
import { createInterface } from "node:readline";
import { BASE, ensureDaemon } from "../core/client.mjs";
import { handleMcp, parseError } from "../core/tool.mjs";

let client = "unknown";

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
    const body = await r.json().catch(() => ({ error: `cev daemon answered HTTP ${r.status}` }));
    if (!r.ok) throw new Error(body.error);
    return body;
  }
}

const out = (m) => m && process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return out(parseError());
  }
  // JSON-RPC batches are gone from MCP since 2025-06-18; answer each item anyway for older clients
  const msgs = Array.isArray(msg) && msg.length ? msg : [msg];
  const replies = await Promise.all(msgs.map((m) => handleMcp(m, { decide, onInitialize: (p) => (client = p.clientInfo?.name ?? client) })));
  if (Array.isArray(msg) && msg.length) {
    const sent = replies.filter(Boolean);
    if (sent.length) out(sent);
  } else out(replies[0]);
});
