#!/usr/bin/env node
// usage: cev decide [req.json|-] [--only claude|codex] [--full] [--local] [--require-answer] [--deadline-ms n]   (no file or "-": read stdin)
//        cev status
//        cev --version
// Uses the daemon's warm pool, starting the daemon if needed; when that isn't possible it asks cold from this process.
// Exit codes: 0 decided (an escalation is still a decision), 1 the decision failed or the daemon refused it, 2 usage,
// 3 with --require-answer when any question escalated (so a script can stop before acting).
import { readFileSync, writeSync } from "node:fs";
import { decide, checkRequest, combine } from "../core/cev.mjs";
import { VERSION } from "../core/tool.mjs";
import { BASE, ensureDaemon } from "../core/client.mjs";

const USAGE = "usage: cev decide [req.json|-] [--only claude|codex] [--full] [--local] [--require-answer] [--deadline-ms n]\n       cev status\n       cev --version";
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
let deadlineMs;
const T0 = performance.now(); // the deadline covers everything from here: starting the daemon, the queue, the model
const left = () => deadlineMs - (performance.now() - T0);
const flags = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--only") {
    only = args[++i];
    if (only !== "claude" && only !== "codex") die(`--only takes claude or codex\n${USAGE}`, 2);
  } else if (a === "--deadline-ms") {
    deadlineMs = Number(args[++i]);
    if (!(deadlineMs > 0)) die(`--deadline-ms takes a positive number of milliseconds\n${USAGE}`, 2);
  } else if (a === "--full" || a === "--local" || a === "--require-answer") flags.add(a);
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
// Past the deadline nothing was decided, which is an escalation of every question, not an error
const late = () => ({ answers: combine(req, [null]), votes: {}, meta: { ms: Math.round(performance.now() - T0), models: {}, error: "deadline passed" } });
const within = (p) => (deadlineMs ? Promise.race([p, new Promise((res) => setTimeout(() => res("late"), Math.max(0, left())).unref())]) : p);
if (deadlineMs) {
  try {
    checkRequest(req); // a bad request is still an error, deadline or not
  } catch (e) {
    die(`cev: ${e.message}`);
  }
}
if (!only && !flags.has("--local")) {
  const up = await within(ensureDaemon().then(() => true, () => false)); // can't start one: the cold path below still decides
  const r =
    up === "late"
      ? "late"
      : await fetch(`${BASE}/decide`, { method: "POST", body: JSON.stringify(req), ...(deadlineMs && { headers: { "x-cev-deadline-ms": String(Math.max(1, Math.floor(left()))) }, signal: AbortSignal.timeout(Math.max(1, Math.ceil(left())) + 500) }) }).catch((e) => (e?.name === "TimeoutError" ? "late" : null));
  if (r === "late") result = late(); // the daemon may hold the request: asking again cold would run it twice
  else if (r?.ok) result = await r.json();
  // The daemon answered but refused (bad request, busy): report it. Falling back to cold would pile uncapped work
  // onto a machine the daemon just said is busy.
  else if (r) die(`cev daemon: ${(await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`}`);
}
if (!result) {
  if (deadlineMs && left() <= 0) result = late();
  else {
    try {
      const timeout = deadlineMs ? { timeout: left() } : {};
      result = await decide(req, { ...(only && { models: [only] }), claude: timeout, codex: timeout });
    } catch (e) {
      die(`cev: ${e.message}`);
    }
  }
}
if (deadlineMs && left() < 0) result = late(); // an answer that came after the deadline is not an answer
// Written synchronously and followed by an explicit exit: a daemon start-up still polling after the deadline must
// not keep this process alive
writeSync(1, JSON.stringify(flags.has("--full") ? result : { answers: result.answers, ms: result.meta.ms, ...(result.meta.replay && { replay: true }) }, null, 1) + "\n");
process.exit(flags.has("--require-answer") && Object.values(result.answers).some((a) => a.escalate) ? 3 : 0);
