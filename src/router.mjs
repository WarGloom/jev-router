import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";
import { JEV_MODEL, TYPESAFE_ORIGIN, readJevApiKey } from "./local-config.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: readJevApiKey(),
    baseURL: TYPESAFE_ORIGIN,
    defaultModel: JEV_MODEL,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

export function configurationChoices(models, effortOverride = null) {
  const configurations = new Map();
  for (const model of models) {
    for (const level of model.efforts ?? []) {
      const effort = typeof level === "string" ? level : level.effort;
      if (!effort || (effortOverride && effort !== effortOverride)) continue;
      const id = `${model.id}::${effort}`;
      configurations.set(id, { model: model.id, effort,
        description: `${model.description ?? model.id}; reasoning effort ${effort}: ${typeof level === "string" ? effort : level.description ?? effort}` });
    }
  }
  return configurations;
}

export function configurationQuestion(configurations) {
  return {
    type: "choice",
    instructions: "Choose the least expensive model and reasoning-effort combination sufficient to complete the requested work correctly. Judge actual reasoning and coding demands, not length alone. Prefer lighter effort for straightforward tasks; reserve stronger effort for difficult multi-step reasoning, debugging and consequential decisions. Choose exactly one supplied configuration.",
    criteria: Object.fromEntries([...configurations].map(([id, item]) => [id, item.description])),
  };
}

export function decodeConfiguration(answer, configurations) {
  const configuration = configurations.get(answer?.choice);
  return configuration ? { ...answer, configurationChoice: answer.choice, choice: configuration.model, effort: configuration.effort } : null;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, currentEffort, contextTokens, models, effortOverride = null }) {
  if (!models?.length) return null;
  const joint = models.some((model) => Array.isArray(model.efforts));
  const configurations = joint ? configurationChoices(models, effortOverride) : null;
  if (joint && !configurations.size) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current, current_effort: currentEffort ?? null, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: joint ? configurationQuestion(configurations) : questionForModels(models) },
  };
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    const selection = joint ? decodeConfiguration(answer, configurations) : answer;
    if (!selection) return null;
    return {
      ...selection,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current} (${err.name})`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
