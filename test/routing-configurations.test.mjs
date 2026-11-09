import test from "node:test";
import assert from "node:assert/strict";
import { configurationChoices, configurationQuestion, decodeConfiguration } from "../src/router.mjs";
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
