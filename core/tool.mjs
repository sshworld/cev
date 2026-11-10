// MCP tool definition, shared by the daemon (/mcp) and the per-session stdio bridge (cli/mcp.mjs).
export const VERSION = "1.2.0";

// MCP revisions this server speaks; reply with the client's if we know it, otherwise our newest
export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const protocolOf = (v) => (PROTOCOLS.includes(v) ? v : PROTOCOLS[0]);

// Clients load this at session start even while the tool itself is deferred, so it says when to reach for cev.
// It is aimed at repeated or unattended judgments: with a person in the conversation, an unsure call is better asked directly.
export const ESCALATE = "If escalate=true, do not act on the answer: ask the user, or in an unattended run take the safe default (skip, hold, leave for review).";
export const INSTRUCTIONS =
  "Use cev_decide for bounded judgments among fixed options that you would otherwise reason out at length in this context, " +
  "especially many in a row or in unattended runs: triage and routing, rubric scoring, go/no-go checks. " +
  "Gather the facts yourself first; cev sees only the state you pass. " +
  ESCALATE;

export const TOOL = {
  name: "cev_decide",
  description:
    "Hand a bounded judgment call to an isolated model call (optionally with a Codex second opinion) instead of reasoning it out in this context. " +
    "Give the facts in `state`, optional `rules`, and typed questions (choice/bool/score). " +
    "Returns per question: answer, conf, agree, escalate. " + ESCALATE + " " +
    "Not for open-ended writing or anything needing tools.",
  inputSchema: {
    type: "object",
    required: ["state", "questions"],
    properties: {
      state: { description: "All facts the decision may use (object or text). The panel sees nothing else." },
      rules: { type: "array", items: { type: "string" }, description: "Policies to apply, highest priority first." },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["id", "type", "ask"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
            type: { type: "string", enum: ["choice", "bool", "score"] },
            ask: { type: "string" },
            options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 20, uniqueItems: true, description: "choice only; \"abstain\" is reserved" },
            scale: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "score only, [lo, hi], default [1,5]" },
            risk: { type: "string", enum: ["low", "medium", "high"], description: "Cost of a wrong answer; higher demands more confidence before auto-answering." },
          },
        },
      },
    },
  },
};

// Declared so clients can rely on structuredContent's shape
TOOL.outputSchema = {
  type: "object",
  required: ["answers", "ms"],
  properties: {
    answers: {
      type: "object",
      description: "Per question id",
      additionalProperties: {
        type: "object",
        required: ["answer", "conf", "agree", "escalate", "why"],
        properties: {
          answer: { type: ["string", "boolean", "number"], description: 'an option, true/false, a score level, or "abstain"' },
          conf: { type: "number" },
          agree: { type: "boolean" },
          escalate: { type: "boolean" },
          why: { type: "string", description: "a quote from state, or empty" },
          missing: { type: "string" },
        },
      },
    },
    ms: { type: "number" },
  },
};

// This is all that lands in the caller's context, so keep it to the answers (votes go to the daemon log only).
export function toolResult(r) {
  const out = { answers: r.answers, ms: r.meta.ms };
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

export const toolError = (e) => ({ content: [{ type: "text", text: `cev error: ${e.message ?? e}` }], isError: true });

// ── MCP JSON-RPC, shared by both transports ──
// Returns the response object, or null when nothing must be sent (notifications, and client responses to us).
const rpc = (id, body) => ({ jsonrpc: "2.0", id, ...body });
export const parseError = () => rpc(null, { error: { code: -32700, message: "parse error" } });

export async function handleMcp(msg, { decide, onInitialize } = {}) {
  const invalid = (id = null) => rpc(id, { error: { code: -32600, message: "invalid request" } });
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return invalid();
  const validId = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
  if (msg.jsonrpc !== "2.0") return invalid(validId ? msg.id : null);
  if (msg.method === undefined && ("result" in msg || "error" in msg)) return null; // a response to us; we never ask anything
  if (typeof msg.method !== "string") return invalid(validId ? msg.id : null);
  if ("id" in msg && !validId) return invalid();
  const notification = !("id" in msg);
  if (notification) return null; // notifications/initialized, cancelled, ...: never answered
  const reply = (result) => rpc(msg.id, { result });
  const fail = (code, message) => rpc(msg.id, { error: { code, message } });
  switch (msg.method) {
    case "initialize":
      onInitialize?.(msg.params ?? {});
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
        return reply(toolError(e)); // tool failures are results with isError, so the model can read them
      }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
