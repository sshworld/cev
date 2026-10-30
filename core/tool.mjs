// MCP tool definition, shared by the daemon (/mcp) and the per-session stdio bridge (cli/mcp.mjs).
export const VERSION = "0.3.1";

// Clients load this at session start even while the tool itself is deferred, so it says when to reach for cev.
export const INSTRUCTIONS =
  "Use cev_decide before acting on a bounded judgment you could get wrong: " +
  "go/no-go before hard-to-reverse actions (deploy, push, send, delete), " +
  "triage or routing among fixed options, and rubric scoring. " +
  "Gather the facts yourself first; cev sees only the state you pass. " +
  "If escalate=true, do not act on the answer — ask the user.";

export const TOOL = {
  name: "cev_decide",
  description:
    "Hand a bounded judgment call to an independent Claude + Codex panel instead of reasoning it out in this context. " +
    "Give the facts in `state`, optional `rules`, and typed questions (choice/bool/score). " +
    "Returns per question: answer, conf, agree, escalate. When escalate=true, do not act on the answer — decide yourself or ask the user. " +
    "Use for routing, triage, rubric scoring, go/no-go checks. Not for open-ended writing or anything needing tools.",
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
