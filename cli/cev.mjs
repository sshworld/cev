#!/usr/bin/env node
// usage: cev decide [req.json|-] [--only claude|codex] [--full] [--local]   (no file or "-": read stdin)
//        cev status
//        cev --version
// Uses the daemon's warm pool, starting the daemon if needed; when that isn't possible it asks cold from this process.
// Exit codes: 0 decided (an escalation is still a decision), 1 the decision failed or the daemon refused it, 2 usage.
import { readFileSync } from "node:fs";
import { decide } from "../core/cev.mjs";
import { VERSION } from "../core/tool.mjs";
import { BASE, ensureDaemon } from "../core/client.mjs";

const USAGE = "usage: cev decide [req.json|-] [--only claude|codex] [--full] [--local]\n       cev status\n       cev --version";
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (cmd === "status") {
  const r = await fetch(`${BASE}/health`).catch(() => null);
  if (!r) die("cev daemon not running");
  console.log(JSON.stringify(await r.json(), null, 1));
  process.exit(0);
}
if (cmd !== "decide") die(USAGE, 2);

let file;
let only;
const flags = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--only") {
    only = args[++i];
    if (only !== "claude" && only !== "codex") die(`--only takes claude or codex\n${USAGE}`, 2);
  } else if (a === "--full" || a === "--local") flags.add(a);
  else if (a.startsWith("--")) die(`unknown flag ${a}\n${USAGE}`, 2);
  else if (file === undefined) file = a;
  else die(USAGE, 2);
}

let req;
try {
  req = JSON.parse(readFileSync(file === undefined || file === "-" ? 0 : file, "utf8"));
} catch (e) {
  die(`cev: can't read the request: ${e.message}`, 2);
}

let result = null;
if (!only && !flags.has("--local")) {
  await ensureDaemon().catch(() => {}); // can't start one: the cold path below still decides
  const r = await fetch(`${BASE}/decide`, { method: "POST", body: JSON.stringify(req) }).catch(() => null);
  if (r?.ok) result = await r.json();
  // The daemon answered but refused (bad request, busy): report it. Falling back to cold would pile uncapped work
  // onto a machine the daemon just said is busy.
  else if (r) die(`cev daemon: ${(await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`}`);
}
if (!result) {
  try {
    result = await decide(req, only ? { models: [only] } : {});
  } catch (e) {
    die(`cev: ${e.message}`);
  }
}
console.log(JSON.stringify(flags.has("--full") ? result : { answers: result.answers, ms: result.meta.ms }, null, 1));
