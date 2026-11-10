import test from "node:test";
import assert from "node:assert/strict";
import { configurationChoices, configurationQuestion, decodeConfiguration } from "../src/router.mjs";
import * as router from "../src/router.mjs";
import { explicitEffort } from "../src/codex-cli.mjs";

const models = [
  { id: "gpt-6-luna", efforts: [{ effort: "low", description: "Light reasoning" }, { effort: "high", description: "Deeper reasoning" }] },
  { id: "gpt-6.1-sol", efforts: [{ effort: "high", description: "Deeper reasoning" }, { effort: "max", description: "Hardest tasks" }] },
];

test("one joint choice contains only actual supported model-effort pairs", () => {
  const choices = configurationChoices(models);
  assert.equal(choices.size, 4);
  assert(!choices.has("gpt-6-luna::max"));
  assert.deepEqual(Object.keys(configurationQuestion(choices).criteria), [...choices.keys()]);
  assert.deepEqual(decodeConfiguration({ choice: "gpt-6.1-sol::max", confidence: .9 }, choices), {
    choice: "gpt-6.1-sol", effort: "max", confidence: .9, configurationChoice: "gpt-6.1-sol::max",
  });
  assert.equal(decodeConfiguration({ choice: "gpt-6-luna::max" }, choices), null);
});

test("explicit effort restricts Jev to models supporting that level", () => {
  const choices = configurationChoices(models, "max");
  assert.deepEqual([...choices.keys()], ["gpt-6.1-sol::max"]);
  assert.equal(configurationChoices(models, "ultra").size, 0);
});

test("explicit CLI effort overrides are distinct from a user prompt", () => {
  assert.equal(explicitEffort(["exec", "-c", 'model_reasoning_effort="high"', "Reply OK"]), "high");
  assert.equal(explicitEffort(["--config=model_reasoning_effort='max'", "exec", "Reply OK"]), "max");
  assert.equal(explicitEffort(["exec", "Please use high reasoning"]), null);
});


test("model selection offers capabilities for exact models rather than model-effort pairs", () => {
  assert.equal(typeof router.buildRoutingRequest, "function");
  const request = router.buildRoutingRequest({ prompt: "diagnose an unknown race", models });
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["gpt-6-luna", "gpt-6.1-sol"]);
  assert.match(request.questions.model.criteria["gpt-6-luna"].insufficient, /Unknown-cause debugging/);
  assert.match(request.questions.model.criteria["gpt-6.1-sol"].suitable, /concurrency/);
  assert(request.questions.task_complexity);
});

test("effort selection is constrained to the final model and decodes its supported level", () => {
  assert.equal(typeof router.buildRoutingRequest, "function");
  const request = router.buildRoutingRequest({ prompt: "diagnose an unknown race", models: [models[0]], selection: "effort" });
  assert.deepEqual(Object.keys(request.questions), ["model"]);
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["low", "high"]);
  assert.match(request.questions.model.instructions.question, /gpt-6-luna/);
  assert.deepEqual(router.decodeRoutingAnswer({ choice: "high", confidence: .8 }, request, models[0]), {
    choice: "gpt-6-luna", effort: "high", confidence: .8,
  });
  assert.equal(router.decodeRoutingAnswer({ choice: "max", confidence: .9 }, request, models[0]), null);
  assert.equal(router.buildRoutingRequest({ prompt: "work", models, selection: "effort" }), null);
});

test("model and effort requests honor an explicit effort restriction", () => {
  assert.equal(typeof router.buildRoutingRequest, "function");
  const request = router.buildRoutingRequest({ prompt: "work", models, effortOverride: "max" });
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["gpt-6.1-sol"]);
  assert.equal(router.buildRoutingRequest({ prompt: "work", models, effortOverride: "ultra" }), null);
  const effort = router.buildRoutingRequest({ prompt: "work", models: [models[1]], selection: "effort", effortOverride: "max" });
  assert.deepEqual(Object.keys(effort.questions.model.criteria), ["max"]);
});

test("routing includes the previous exchange as structured task context", () => {
  assert.equal(typeof router.buildRoutingRequest, "function");
  const previousExchange = [{ role: "user", text: "diagnose this race" }, { role: "assistant", text: "The cause spans transaction boundaries." }];
  const request = router.buildRoutingRequest({ prompt: "fix it", models, previousExchange });
  assert.deepEqual(request.state.previous_exchange, previousExchange);
  assert.equal(request.state.request, "fix it");
  assert(!Object.hasOwn(router.buildRoutingRequest({ prompt: "work", models }).state, "previous_exchange"));
  assert.equal(router.decodeRoutingAnswer({ choice: "not-available" }, request), null);
});

test("legacy Claude model routing retains its tier guidance", () => {
  assert.equal(typeof router.buildRoutingRequest, "function");
  const request = router.buildRoutingRequest({ prompt: "debug", models: [{ id: "claude-opus-5", tier: "opus", description: "Opus" }] });
  assert.match(request.questions.model.criteria["claude-opus-5"].signals.join(" "), /security/);
});
