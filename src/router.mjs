import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  questionForEffort,
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

/** Build one model question or one final-model reasoning question. */
export function buildRoutingRequest({ prompt, current, currentEffort, contextTokens, models = [], effortOverride = null, selection = "model", previousExchange = [] }) {
  if (!models.length || !["model", "effort"].includes(selection)) return null;
  const eligible = models.filter((model) => !effortOverride || (model.efforts ?? []).some((level) =>
    (typeof level === "string" ? level : level.effort) === effortOverride));
  if (!eligible.length || (selection === "effort" && models.length !== 1)) return null;
  const modelQuestion = selection === "effort"
    ? questionForEffort(eligible[0], effortOverride)
    : questionForModels(eligible);
  if (!Object.keys(modelQuestion.criteria).length) return null;
  const context = previousExchange.filter((item) =>
    ["user", "assistant"].includes(item?.role) && typeof item.text === "string" && item.text.trim())
    .map(({ role, text }) => ({ role, text }));
  return {
    state: {
      request: prompt,
      ...(context.length ? { previous_exchange: context } : {}),
      session: { current_model: current, current_effort: currentEffort ?? null, context_tokens: contextTokens },
      environment: { available_models: eligible.map((model) => model.id) },
    },
    questions: { ...(selection === "model" ? QUESTIONS : {}), model: modelQuestion },
  };
}

/** Validate the exact option before normalizing a final model's reasoning choice. */
export function decodeRoutingAnswer(answer, request, effortModel = null) {
  if (!answer || !Object.hasOwn(request.questions.model.criteria, answer.choice)) return null;
  return effortModel ? { ...answer, choice: effortModel.id, effort: answer.choice } : answer;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, currentEffort, contextTokens, models, effortOverride = null, selection = "model", previousExchange = [], signal }) {
  if (signal?.aborted) return null;
  const request = buildRoutingRequest({ prompt, current, currentEffort, contextTokens, models, effortOverride, selection, previousExchange });
  if (!request) return null;
  const started = Date.now();
  const abort = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    const result = await getClient().systemOne(request, { signal: requestSignal });
    const answers = result.answers ?? {};
    const selected = decodeRoutingAnswer(answers.model, request, selection === "effort" ? models[0] : null);
    if (!selected) return null;
    const scored = ["task_complexity", "reasoning_required", "tool_complexity"]
      .every((key) => Number.isFinite(answers[key]?.score));
    return {
      ...selected,
      request,
      response: result,
      metrics: scored ? {
        taskComplexity: answers.task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: answers.reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: answers.tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      } : null,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (!signal?.aborted) log(`routing failed, keeping ${current} (${err.name})`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
