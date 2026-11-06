// Pure-logic tests: no model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combine, schemaOf, groundedIn, route, checkRequest, validVote } from "../core/cev.mjs";
import { protocolOf, PROTOCOLS } from "../core/tool.mjs";

const choice = (risk) => ({ state: "PR #12: tests pass, 3 files changed", questions: [{ id: "a", type: "choice", ask: "merge?", options: ["merge", "review"], risk }] });
// Text fields every schema-conforming vote carries
const T = { evidence: "", missing: "" };
const vote = (choice, probs, evidence = "") => ({ a: { choice, probs, evidence, missing: "" } });

test("choice: agreeing confident votes auto-answer", () => {
  const req = choice("medium");
  const r = combine(req, [vote("merge", { merge: 0.9, review: 0.1, abstain: 0 }), vote("merge", { merge: 0.8, review: 0.2, abstain: 0 })]).a;
  assert.equal(r.answer, "merge");
  assert.equal(r.conf, 0.85);
  assert.equal(r.agree, true);
  assert.equal(r.escalate, false);
});

test("choice: disagreement escalates", () => {
  const r = combine(choice("low"), [vote("merge", { merge: 0.9, review: 0.1, abstain: 0 }), vote("review", { merge: 0.2, review: 0.8, abstain: 0 })]).a;
  assert.equal(r.agree, false);
  assert.equal(r.escalate, true);
});

test("choice: confidence below the risk threshold escalates", () => {
  const votes = [vote("merge", { merge: 0.8, review: 0.2, abstain: 0 }), vote("merge", { merge: 0.8, review: 0.2, abstain: 0 })];
  assert.equal(combine(choice("medium"), votes).a.escalate, false); // 0.8 ≥ 0.75
  assert.equal(combine(choice("high"), votes).a.escalate, true); // 0.8 < 0.9
});

test("choice: a missing vote escalates", () => {
  const r = combine(choice("low"), [vote("merge", { merge: 0.99, review: 0.01, abstain: 0 }), null]).a;
  assert.equal(r.escalate, true);
});

test("no votes at all abstains", () => {
  const r = combine(choice("low"), [null, null]).a;
  assert.deepEqual([r.answer, r.escalate], ["abstain", true]);
});

test("probabilities are normalized before averaging", () => {
  const r = combine(choice("low"), [vote("merge", { merge: 9, review: 1, abstain: 0 }), vote("merge", { merge: 0.9, review: 0.1, abstain: 0 })]).a;
  assert.equal(r.conf, 0.9);
});

test("bool: any abstain abstains", () => {
  const req = { state: "x", questions: [{ id: "a", type: "bool", ask: "?" }] };
  const r = combine(req, [{ a: { p_yes: 0.9, abstain: false, ...T } }, { a: { p_yes: 0.5, abstain: true, ...T } }]).a;
  assert.deepEqual([r.answer, r.escalate], ["abstain", true]);
});

test("bool: averages p_yes", () => {
  const req = { state: "x", questions: [{ id: "a", type: "bool", ask: "?", risk: "low" }] };
  const r = combine(req, [{ a: { p_yes: 0.1, abstain: false, ...T } }, { a: { p_yes: 0.2, abstain: false, ...T } }]).a;
  assert.deepEqual([r.answer, r.conf, r.escalate], [false, 0.85, false]);
});

test("score: one level apart still agrees, and conf counts ±1", () => {
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?", scale: [1, 5], risk: "low" }] };
  const p = (m) => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, abstain: 0, ...m });
  const r = combine(req, [{ a: { score: "3", probs: p({ 3: 0.7, 4: 0.3 }), ...T } }, { a: { score: "4", probs: p({ 4: 0.6, 3: 0.4 }), ...T } }]).a;
  assert.equal(r.answer, 3);
  assert.equal(r.agree, true);
  assert.equal(r.conf, 1);
});

test("score: two levels apart disagrees", () => {
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?" }] };
  const p = (m) => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, abstain: 0, ...m });
  const r = combine(req, [{ a: { score: "2", probs: p({ 2: 1 }), ...T } }, { a: { score: "4", probs: p({ 4: 1 }), ...T } }]).a;
  assert.equal(r.agree, false);
  assert.equal(r.escalate, true);
});

test("evidence is kept only when it is quoted from the state", () => {
  const req = choice("low");
  const probs = { merge: 1, review: 0, abstain: 0 };
  assert.equal(combine(req, [vote("merge", probs, "made up"), vote("merge", probs, "tests pass")]).a.why, "tests pass");
  assert.equal(groundedIn("Tests  PASS, ok", '"tests pass."'), true);
  assert.equal(groundedIn("tests pass", "tests fail"), false);
  assert.equal(groundedIn("anything", ""), null);
});

test("schema: strict, with abstain as an option", () => {
  const s = schemaOf({ questions: [{ id: "a", type: "choice", options: ["x", "y"] }, { id: "b", type: "score", scale: [0, 2] }, { id: "c", type: "bool" }] });
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ["a", "b", "c"]);
  assert.deepEqual(s.properties.a.properties.choice.enum, ["x", "y", "abstain"]);
  assert.deepEqual(s.properties.b.properties.score.enum, ["0", "1", "2", "abstain"]);
  assert.deepEqual(s.properties.c.required, ["p_yes", "abstain", "evidence", "missing"]);
});

test("route: Claude alone unless the Codex second opinion is enabled", () => {
  const q = (type, risk) => ({ id: "q", type, ask: "?", risk });
  for (const req of [{ questions: [q("choice", "low")] }, { questions: [q("score", "high")] }, { questions: [q("bool", undefined)] }]) {
    assert.deepEqual(route(req, { codex: false }), ["claude"]);
  }
});

test("route: with Codex enabled, only low-risk non-score requests skip it", () => {
  const q = (type, risk) => ({ id: "q", type, ask: "?", risk });
  assert.deepEqual(route({ questions: [q("choice", "low"), q("bool", "low")] }, { codex: true }), ["claude"]);
  assert.deepEqual(route({ questions: [q("choice", "low"), q("bool", "medium")] }, { codex: true }), ["claude", "codex"]);
  assert.deepEqual(route({ questions: [q("score", "low")] }, { codex: true }), ["claude", "codex"]);
  assert.deepEqual(route({ questions: [q("choice", undefined)] }, { codex: true }), ["claude", "codex"]);
});

test("checkRequest rejects malformed requests", () => {
  assert.throws(() => checkRequest({ questions: [] }), /state and questions/);
  assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "rank", ask: "?" }] }), /bad question/);
  assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "choice", ask: "?", options: ["only"] }] }), /needs options/);
  assert.doesNotThrow(() => checkRequest(choice("low")));
});

// ── Fail-open regressions: each of these used to auto-answer instead of escalating ──
test("choice: a vote that chose abstain abstains, whatever its probs say", () => {
  const r = combine(choice("low"), [vote("abstain", { merge: 0.95, review: 0.05, abstain: 0 }), vote("abstain", { merge: 0.95, review: 0.05, abstain: 0 })]).a;
  assert.deepEqual([r.answer, r.conf, r.escalate], ["abstain", 0, true]);
  const one = combine(choice("low"), [vote("merge", { merge: 0.99, review: 0.01, abstain: 0 }), vote("abstain", { merge: 0.9, review: 0, abstain: 0.1 })]).a;
  assert.deepEqual([one.answer, one.escalate], ["abstain", true]);
});

test("score: a vote that chose abstain abstains", () => {
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?", risk: "low" }] };
  const p = { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0, abstain: 0 };
  const r = combine(req, [{ a: { score: "abstain", probs: p, ...T } }]).a;
  assert.deepEqual([r.answer, r.escalate], ["abstain", true]);
});

test("out-of-range or malformed votes are dropped, so they escalate", () => {
  const bool = { state: "x", questions: [{ id: "a", type: "bool", ask: "?", risk: "low" }] };
  for (const a of [{ p_yes: 2, abstain: false, ...T }, { p_yes: -0.1, abstain: false, ...T }, { p_yes: "0.9", abstain: false, ...T }, { p_yes: 0.9, ...T }]) {
    const r = combine(bool, [{ a }]).a;
    assert.equal(r.escalate, true, JSON.stringify(a));
    assert.ok(r.conf <= 1);
  }
  const bad = [
    vote("delete", { merge: 1, review: 0, abstain: 0 }), // not an option
    vote("merge", { merge: 1, review: 0 }), // a key missing
    vote("merge", { merge: -1, review: 2, abstain: 0 }), // negative weight
    vote("merge", { merge: 0, review: 0, abstain: 0 }), // all zero
    vote("merge", { merge: Infinity, review: 0, abstain: 0 }),
  ];
  for (const v of bad) assert.equal(combine(choice("low"), [v]).a.escalate, true, JSON.stringify(v));
});

test("a stray key in probs or the vote rejects the vote", () => {
  assert.equal(combine(choice("low"), [vote("merge", { merge: 0.3, review: 0.1, abstain: 0, rm_rf: 5 })]).a.escalate, true);
  const extra = { a: { ...vote("merge", { merge: 1, review: 0, abstain: 0 }).a, note: "x" } };
  assert.equal(combine(choice("low"), [extra]).a.escalate, true);
});

test("validVote accepts unnormalized weights and numeric score strings", () => {
  const q = { id: "a", type: "score", scale: [1, 3] };
  assert.equal(validVote(q, { score: "2", probs: { 1: 0, 2: 3, 3: 1, abstain: 0 }, ...T }), true);
  assert.equal(validVote(q, { score: "4", probs: { 1: 0, 2: 3, 3: 1, abstain: 0 }, ...T }), false);
});

test("checkRequest rejects fields that would bypass escalation", () => {
  const one = (q) => ({ state: "x", questions: [{ id: "a", type: "choice", ask: "?", options: ["x", "y"], ...q }] });
  assert.throws(() => checkRequest(one({ risk: "HIGH" })), /risk must be/);
  assert.throws(() => checkRequest(one({ options: ["x", "abstain"] })), /reserved/);
  assert.throws(() => checkRequest(one({ options: ["x", "x"] })), /distinct/);
  assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "bool", ask: "?" }, { id: "a", type: "bool", ask: "?" }] }), /duplicate/);
  for (const scale of [[5, 1], [1, 1], [0, 1000], [1.5, 3], [1, 2, 3]]) {
    assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "score", ask: "?", scale }] }), /scale/, String(scale));
  }
  assert.throws(() => checkRequest({ state: "x", questions: Array.from({ length: 21 }, (_, i) => ({ id: `q${i}`, type: "bool", ask: "?" })) }), /at most/);
  assert.doesNotThrow(() => checkRequest(one({ risk: "high" })));
});

test("combine treats an unknown risk as high rather than never escalating", () => {
  const votes = [vote("merge", { merge: 0.8, review: 0.2, abstain: 0 })];
  assert.equal(combine(choice("HIGH"), votes).a.escalate, true);
});

test("protocol: echo a known MCP revision, otherwise offer our newest", () => {
  assert.equal(protocolOf("2025-03-26"), "2025-03-26");
  assert.equal(protocolOf("2099-01-01"), PROTOCOLS[0]);
  assert.equal(protocolOf(undefined), PROTOCOLS[0]);
});

test("a non-string pick is rejected, so [\"abstain\"] can't pass as an option", () => {
  const probs = { merge: 1, review: 0, abstain: 0 };
  for (const pick of [["abstain"], ["merge"], { toString: () => "merge" }]) {
    assert.equal(combine(choice("low"), [{ a: { choice: pick, probs, ...T } }]).a.escalate, true, JSON.stringify(pick));
  }
});

test("a vote missing its schema text fields is dropped", () => {
  const r = combine(choice("low"), [{ a: { choice: "merge", probs: { merge: 1, review: 0, abstain: 0 } } }]).a;
  assert.equal(r.escalate, true);
});

// ── Round-2 regressions ──
test("probs that contradict every pick don't authorize an answer", () => {
  const v = { a: { choice: "review", probs: { merge: 1, review: 0, abstain: 0 }, ...T } };
  const r = combine(choice("high"), [v, v]).a;
  assert.deepEqual([r.agree, r.escalate], [false, true]);
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?", risk: "low" }] };
  const s = { a: { score: "1", probs: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, abstain: 0 }, ...T } };
  assert.equal(combine(req, [s, s]).a.escalate, true);
});

test("scales must be small safe integers", () => {
  for (const scale of [[9007199254740992, 9007199254740994], [2e6, 2e6 + 2]]) {
    assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "score", ask: "?", scale }] }), /scale/);
  }
});

test("question ids are plain identifiers", () => {
  for (const id of ["__proto__", "", "1a", "a b", "x".repeat(65)]) {
    assert.throws(() => checkRequest({ state: "x", questions: [{ id, type: "bool", ask: "?" }] }), /id/, id);
  }
  assert.doesNotThrow(() => checkRequest({ state: "x", questions: [{ id: "ci_ok-2", type: "bool", ask: "?" }] }));
});

test("an inherited property name as risk never disables the threshold", () => {
  const votes = [vote("merge", { merge: 0.51, review: 0.49, abstain: 0 })];
  for (const risk of ["constructor", "toString", "__proto__"]) assert.equal(combine(choice(risk), votes).a.escalate, true, risk);
});

test("decide() validates before calling any model", async () => {
  const { decide } = await import("../core/cev.mjs");
  await assert.rejects(decide({ state: "x", questions: [{ id: "a", type: "bool", ask: "?", risk: "constructor" }] }, { log: false }), /risk/);
});

test("MCP: notifications and client responses get no reply; junk gets a JSON-RPC error", async () => {
  const { handleMcp, TOOL } = await import("../core/tool.mjs");
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "ping" }), null);
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handleMcp({ jsonrpc: "2.0", id: 3, result: {} }), null);
  for (const junk of [null, 5, "x", []]) assert.equal((await handleMcp(junk)).error.code, -32600);
  assert.equal((await handleMcp({ jsonrpc: "2.0", id: 1, method: "nope" })).error.code, -32601);
  const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  const call = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL.name, arguments: {} } }, { decide: async () => Promise.reject(new Error("need state")) });
  assert.equal(call.result.isError, true);
  assert.ok(TOOL.outputSchema.properties.answers);
});

test("an id named like an Object.prototype member still gets its own answer", () => {
  const req = { state: "x", questions: [{ id: "constructor", type: "bool", ask: "?", risk: "low" }] };
  checkRequest(req);
  const r = combine(req, [{ constructor: { p_yes: 0.9, abstain: false, ...T } }]);
  assert.equal(Object.hasOwn(r, "constructor"), true);
  assert.equal(JSON.parse(JSON.stringify(r)).constructor.answer, true);
  assert.ok(Object.hasOwn(schemaOf(req).properties, "constructor"));
});

test("MCP: malformed envelopes are errors, not silently dropped", async () => {
  const { handleMcp } = await import("../core/tool.mjs");
  assert.equal((await handleMcp({ jsonrpc: "2.0", id: 1 })).error.code, -32600); // no method, no result: a broken request
  assert.equal((await handleMcp({ jsonrpc: "1.0", id: 1, method: "ping" })).error.code, -32600);
  assert.equal((await handleMcp({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).error.code, -32600);
  assert.equal(await handleMcp({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "x" } }), null);
});
