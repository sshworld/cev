#!/usr/bin/env node
// usage: cev decide req.json [--only claude|codex] [--full] [--local]
//       cat req.json | cev decide -
//       cev status
// Uses the daemon's warm pool when it's running, otherwise asks cold from this process.
import { readFileSync } from "node:fs";
import { decide } from "../core/cev.mjs";

const BASE = `http://127.0.0.1:${process.env.CEV_PORT ?? 7767}`;
const [cmd, file = "-", ...rest] = process.argv.slice(2);

if (cmd === "status") {
  const r = await fetch(`${BASE}/health`).catch(() => null);
  console.log(r ? JSON.stringify(await r.json(), null, 1) : "cev daemon not running");
  process.exit(r ? 0 : 1);
}
if (cmd !== "decide") {
  console.error("usage: cev decide <req.json|-> [--only claude|codex] [--full] [--local]\n       cev status");
  process.exit(2);
}
const req = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
const only = rest.includes("--only") ? [rest[rest.indexOf("--only") + 1]] : undefined;

let result = null;
if (!only && !rest.includes("--local")) {
  const r = await fetch(`${BASE}/decide`, { method: "POST", body: JSON.stringify(req) }).catch(() => null);
  if (r?.ok) result = await r.json();
  else if (r) console.error(`cev daemon: ${(await r.json()).error}`);
}
result ??= await decide(req, only && { models: only });
console.log(JSON.stringify(rest.includes("--full") ? result : { answers: result.answers, ms: result.meta.ms }, null, 1));
