// Pure-logic tests: no model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combine, schemaOf, groundedIn, route, checkRequest } from "../core/cev.mjs";

const choice = (risk) => ({ state: "PR #12: tests pass, 3 files changed", questions: [{ id: "a", type: "choice", ask: "merge?", options: ["merge", "review"], risk }] });
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
  const r = combine(req, [{ a: { p_yes: 0.9, abstain: false } }, { a: { p_yes: 0.5, abstain: true } }]).a;
  assert.deepEqual([r.answer, r.escalate], ["abstain", true]);
});

test("bool: averages p_yes", () => {
  const req = { state: "x", questions: [{ id: "a", type: "bool", ask: "?", risk: "low" }] };
  const r = combine(req, [{ a: { p_yes: 0.1, abstain: false } }, { a: { p_yes: 0.2, abstain: false } }]).a;
  assert.deepEqual([r.answer, r.conf, r.escalate], [false, 0.85, false]);
});

test("score: one level apart still agrees, and conf counts ±1", () => {
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?", scale: [1, 5], risk: "low" }] };
  const p = (m) => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, abstain: 0, ...m });
  const r = combine(req, [{ a: { score: "3", probs: p({ 3: 0.7, 4: 0.3 }) } }, { a: { score: "4", probs: p({ 4: 0.6, 3: 0.4 }) } }]).a;
  assert.equal(r.answer, 3);
  assert.equal(r.agree, true);
  assert.equal(r.conf, 1);
});

test("score: two levels apart disagrees", () => {
  const req = { state: "x", questions: [{ id: "a", type: "score", ask: "?" }] };
  const p = (m) => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, abstain: 0, ...m });
  const r = combine(req, [{ a: { score: "2", probs: p({ 2: 1 }) } }, { a: { score: "4", probs: p({ 4: 1 }) } }]).a;
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

test("route: Claude alone only for low-risk non-score questions", () => {
  const q = (type, risk) => ({ id: "q", type, ask: "?", risk });
  assert.deepEqual(route({ questions: [q("choice", "low"), q("bool", "low")] }), ["claude"]);
  assert.deepEqual(route({ questions: [q("choice", "low"), q("bool", "medium")] }), ["claude", "codex"]);
  assert.deepEqual(route({ questions: [q("score", "low")] }), ["claude", "codex"]);
  assert.deepEqual(route({ questions: [q("choice", undefined)] }), ["claude", "codex"]);
});

test("checkRequest rejects malformed requests", () => {
  assert.throws(() => checkRequest({ questions: [] }), /state and questions/);
  assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "rank", ask: "?" }] }), /bad question/);
  assert.throws(() => checkRequest({ state: "x", questions: [{ id: "a", type: "choice", ask: "?", options: ["only"] }] }), /needs options/);
  assert.doesNotThrow(() => checkRequest(choice("low")));
});
