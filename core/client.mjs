// Talking to the shared daemon: find it, replace one left over from another version, start it when it isn't running.
// Used by the MCP bridge, the CLI and the command gate, so all three get the warm pool.
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, ensureHome } from "./cev.mjs";
import { VERSION } from "./tool.mjs";

export const BASE = `http://127.0.0.1:${process.env.CEV_PORT ?? 7767}`;
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call here has a deadline: something else listening on the port must not hang the caller
export const health = () => fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// A daemon from another cev version keeps answering after an upgrade (it outlives sessions), so replace it once it
// is idle. While it is busy for other sessions, use it as is rather than cut their decisions off.
async function retireStale() {
  const h = await health();
  if (!h || h.version === VERSION) return;
  const r = await fetch(`${BASE}/retire`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(() => null);
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

export async function ensureDaemon() {
  await retireStale();
  if (await health()) return;
  ensureHome();
  const log = openSync(join(HOME, "daemon.log"), "a", 0o600);
  // Detached so it outlives this session for others to use. If several sessions race, whoever binds the port wins.
  let gone = false;
  try {
    const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: ["ignore", log, log] });
    child.on("exit", () => (gone = true)).on("error", () => (gone = true));
    child.unref();
  } finally {
    closeSync(log); // the child has its own copy; keeping ours would leak one per daemon start
  }
  for (let i = 0; i < 50; i++) {
    await pause(200);
    if (await health()) return;
    if (gone) break; // it exited (port taken by something else, or it can't start): don't wait the full ten seconds
  }
  throw new Error(`cev server did not start, see ${join(HOME, "daemon.log")}`);
}
