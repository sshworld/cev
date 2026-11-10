// Replay: the same question, asked again the same day of the same model by the same cev, gets the stored result.
// It makes "same input, same result" hold where the model alone doesn't quite (a confidence sitting on the bar can
// land either side), and a repeat costs no model call. A replayed answer is exactly as right as the first one was:
// replay adds repeatability, never correctness.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HOME, SYSTEM, promptOf, schemaOf, thresholdOf, keysOf } from "./cev.mjs";
import { VERSION } from "./tool.mjs";

const FILE = join(HOME, "replay.jsonl");
const MAX = 5000;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SYSTEM_ID = sha(SYSTEM).slice(0, 16);
// Local calendar day. It is part of the key because a rule like "older than 7 days" can make the right answer change
// overnight without the request changing, when the caller left today's date out of the state.
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The key is built from exactly what the model is sent (prompt and schema, in the caller's order) plus everything
// that decides how its answer is judged: the bars, this cev version, the system prompt, the resolved model and effort.
export function keyOf(req, { model, effort }, day = today()) {
  if (!model) return null; // which model would answer isn't known yet, so nothing stored can be trusted to match
  return sha(JSON.stringify([VERSION, SYSTEM_ID, model, effort ?? "", day, promptOf(req), schemaOf(req), req.questions.map((q) => thresholdOf(q.risk))]));
}

const wellFormed = (e) => e && typeof e.key === "string" && typeof e.day === "string" && e.answers && typeof e.answers === "object" && Object.values(e.answers).every((a) => a && typeof a.escalate === "boolean" && "answer" in a);

// A stored entry is returned only if it could have been produced for this request: one answer per question, each a
// value the question allows, and an auto-answer only with a confidence that clears the question's bar. The file is
// plain text on disk; whatever ends up in it, it can't authorize an answer the live path would not have given.
const allowed = (q, a) => {
  if (!a || typeof a.escalate !== "boolean" || typeof a.conf !== "number" || !(a.conf >= 0 && a.conf <= 1)) return false;
  if (a.answer === "abstain") return a.escalate === true;
  const ok = q.type === "bool" ? typeof a.answer === "boolean" : q.type === "score" ? Number.isInteger(a.answer) && keysOf(q).includes(String(a.answer)) : typeof a.answer === "string" && keysOf(q).includes(a.answer);
  return ok && (a.escalate || a.conf >= thresholdOf(q.risk));
};
const fits = (req, answers) => Object.keys(answers).length === req.questions.length && req.questions.every((q) => allowed(q, answers[q.id]));

export function openReplay({ file = FILE, day = today } = {}) {
  const mem = new Map();
  // Keep only today's entries (older ones can never match) and drop a line cut off by a crash
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (wellFormed(e) && e.day === day()) mem.set(e.key, e);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, [...mem.values()].map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
  return {
    get(key, req) {
      const e = key && mem.get(key);
      return e && e.day === day() && fits(req, e.answers) ? e : null;
    },
    put(key, { answers, votes }) {
      if (!key || mem.has(key)) return; // the first completed decision stands
      if (mem.size >= MAX) mem.delete(mem.keys().next().value);
      const e = { key, day: day(), at: new Date().toISOString(), answers, votes };
      mem.set(key, e);
      try {
        appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
      } catch {}
    },
    size: () => mem.size,
  };
}
