// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this confidence, use a balanced downgrade fallback and cap uncertain upgrades. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

export const CODEX_CAPABILITIES = {
  'gpt-6-luna': {
    suitable: 'Self-contained factual answers, translation, formatting, or a single fully specified mechanical edit with an obvious check.',
    insufficient: 'Unknown-cause debugging, ambiguous failures, design decisions, cross-module reasoning, security or concurrency analysis. Raising effort does not remove these capability limits.',
  },
  'gpt-6.1-terra': {
    suitable: 'Ordinary scoped engineering: implement a specified function or endpoint, fix an understood local bug, inspect relevant source and interpret tests with a clear goal.',
    insufficient: 'Deep unknown-cause or cross-component debugging, security trust boundaries, subtle concurrency, architectural decisions or difficult correctness arguments.',
  },
  'gpt-6.1-sol': {
    suitable: 'Difficult reasoning: unknown-cause diagnosis, competing hypotheses, cross-component behavior, security, concurrency, architecture, or consequential correctness decisions.',
    unnecessary: 'Direct factual answers and fully specified mechanical work.',
  },
};

export const REASONING_CRITERIA = {
  low: 'Direct answer or mechanical action; no substantial reasoning chain or uncertainty to resolve.',
  medium: 'A bounded sequence of reasoning steps; ordinary implementation or an understood local bug.',
  high: 'Unknown-cause investigation, competing hypotheses, or nontrivial interactions and correctness reasoning.',
  xhigh: 'Several coupled hard constraints requiring deep cross-module reasoning and failure analysis.',
  max: 'Sustained difficult reasoning about interacting algorithms, invariants, concurrency or proofs.',
  ultra: 'The hardest multi-component work that benefits from automatic task delegation.',
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) => {
  if (models.every(({ id }) => Object.hasOwn(CODEX_CAPABILITIES, id))) {
    return choice(
      "Which model has sufficient capability for this task? Prefer an efficient model within the required capability class.",
      Object.fromEntries(models.map(({ id }) => [id, CODEX_CAPABILITIES[id]])),
    );
  }
  return choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );
};

/** Ask only about levels supported by the model already selected by policy. */
export const questionForEffort = (model, effortOverride = null) => choice(
  {
    question: `Which supported reasoning level should ${model.id} use for this task? Treat the current effort as context, not a requirement. Use low only for direct or mechanical work; ordinary implementation usually needs medium, and uncertain diagnosis or nontrivial correctness reasoning needs high or more. Choose based on the actual task, not a fixed preference for low.`,
    capability: CODEX_CAPABILITIES[model.id] ?? { model: model.description ?? model.id, ...GUIDANCE[model.tier] },
  },
  Object.fromEntries((model.efforts ?? []).flatMap((level) => {
    const effort = typeof level === "string" ? level : level.effort;
    if (!effort || (effortOverride && effort !== effortOverride)) return [];
    return [[effort, REASONING_CRITERIA[effort] ?? (typeof level === "string" ? effort : level.description ?? effort)]];
  })),
);

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
