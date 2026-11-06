// MCP tool definition, shared by the daemon (/mcp) and the per-session stdio bridge (cli/mcp.mjs).
export const VERSION = "0.4.0";

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
        items: {
          type: "object",
          required: ["id", "type", "ask"],
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["choice", "bool", "score"] },
            ask: { type: "string" },
            options: { type: "array", items: { type: "string" }, description: "choice only" },
            scale: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "score only, [lo, hi], default [1,5]" },
            risk: { type: "string", enum: ["low", "medium", "high"], description: "Cost of a wrong answer; higher demands more confidence before auto-answering." },
          },
        },
      },
    },
  },
};

// This is all that lands in the caller's context, so keep it to the answers (votes go to the daemon log only).
export function toolResult(r) {
  const out = { answers: r.answers, ms: r.meta.ms };
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

export const toolError = (e) => ({ content: [{ type: "text", text: `cev error: ${e.message ?? e}` }], isError: true });
