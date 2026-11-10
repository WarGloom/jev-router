import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("a complaint that says a task runs on Luna is not a model override", () => {
  const prompt = "Routing is broken; it always runs on Luna low, despite Jev recommending Sol high.";
  assert.equal(detectOverride(prompt), null);
  const out = decide({ ...base, prompt, current: "haiku", jev: sure("opus") });
  assert.deepEqual(out, { tier: "opus", reason: "jev", changed: true });
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("keeps a balanced current model when a downgrade is uncertain", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-fallback/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("context length never vetoes a confident downgrade", () => {
  for (const contextTokens of [0, 19999, 20000, 20001, 70321, 80000, 200000, 475000]) {
    assert.deepEqual(decide({ ...base, current: "opus", jev: { choice: "haiku", confidence: 0.64 }, contextTokens }), {
      tier: "haiku", reason: "jev", changed: true,
    });
  }
});

test("uncertain downgrades leave a strong model for the balanced fallback", () => {
  assert.deepEqual(decide({ ...base, current: "opus", jev: unsure("haiku"), contextTokens: 80000 }), {
    tier: "sonnet", reason: "low-confidence-fallback", changed: true,
  });
});

test("uncertainty does not downgrade below the recommended tier", () => {
  assert.equal(decide({ ...base, current: "fable", jev: unsure("opus") }).tier, "opus");
});

test("explicit overrides still win in a long uncertain conversation", () => {
  assert.equal(decide({ ...base, prompt: "use sol", current: "opus", jev: unsure("haiku"), contextTokens: 80000 }).tier, "opus");
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});
