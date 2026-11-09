import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel, THRESHOLDS } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
const DEFAULT_MODELS = {
  haiku: "gpt-6-luna",
  sonnet: "gpt-6.1-terra",
  opus: "gpt-6.1-sol",
};
const fallbackModels = new Map(JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf8")).models.map((model) => [model.slug, model]));
export const codexModelOf = (tier) => DEFAULT_MODELS[tier];
export const codexTierOf = (model) => Object.keys(DEFAULT_MODELS).find((tier) => DEFAULT_MODELS[tier] === model) ?? null;
const allowedModel = (model) => model === CODEX_AUTO_MODEL || codexTierOf(model) !== null;

/** Exact configured models with live catalog metadata and bundled metadata as fallback. */
export function codexModels(models = new Map()) {
  return Object.keys(DEFAULT_MODELS).map((tier) => {
    const id = codexModelOf(tier);
    const fallback = fallbackModels.get(id);
    const live = models.get(id);
    const model = live ?? fallback;
    const effortInfo = live?.supported_reasoning_levels?.length ? live : fallback;
    return {
      id,
      tier,
      description: [model?.display_name, model?.description, model?.context_window && `${model.context_window} context tokens`].filter(Boolean).join("; ") || id,
      efforts: effortInfo?.supported_reasoning_levels ?? [],
      defaultEffort: effortInfo?.default_reasoning_level,
    };
  });
}

const supportsEffort = (model, effort) => model?.efforts.some((item) => item.effort === effort);
const compatibleEffort = (model, preferred) =>
  supportsEffort(model, preferred) ? preferred : model?.defaultEffort;

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models)) return catalog;
  catalog.models = catalog.models.filter((model) => allowedModel(model.slug));
  if (catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) return catalog;
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier), effort) {
  const info = codexModels(models).find((candidate) => candidate.id === model);
  if (!info) throw new Error("Unsupported model");
  const selectedEffort = compatibleEffort(info, effort ?? body.reasoning?.effort);
  if (!supportsEffort(info, selectedEffort)) throw new Error("No supported reasoning effort");
  body.model = model;
  body.reasoning = { ...body.reasoning, effort: selectedEffort };
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), effort, confidence, reason }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const modelWithEffort = effort ? `${model} (${effort})` : model;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${modelWithEffort}. Check api_key_file in ~/.config/jev-router/config.json.`
    : `[Jev] routed this turn to ${modelWithEffort} (${detail}).`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  statusId = "",
  effortOverride = null,
} = {}) {
  const token = randomBytes(32).toString("hex");
  const expectedToken = Buffer.from(token);
  const states = new Map();
  const models = new Map();

  const server = http.createServer((req, res) => {
    const supplied = req.headers["x-jev-session"];
    const suppliedToken = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
    if (req.headers.origin !== undefined || suppliedToken.length !== expectedToken.length ||
        !timingSafeEqual(suppliedToken, expectedToken)) {
      res.writeHead(403).end();
      req.resume();
      return;
    }
    const maxBody = 32 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        tooLarge = true;
        chunks.length = 0;
        res.writeHead(413).end();
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let out = Buffer.concat(chunks);
      let routing;
      const isResponse = req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "");
      let body;
      if (out.length) {
        try {
          body = JSON.parse(out.toString());
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (body?.model !== undefined && !allowedModel(body.model)) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Model is not allowed", type: "model_forbidden" } }));
          return;
        }
      }
      if (isResponse) {
        try {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            res.writeHead(400).end();
            return;
          }
          if (body.model === CODEX_AUTO_MODEL) {
            const key = codexConversationKey(body);
            const candidates = codexModels(models).filter((candidate) =>
              availableTiers().includes(candidate.tier) && (!effortOverride || supportsEffort(candidate, effortOverride)),
            );
            if (!candidates.length) throw new Error("Unsupported reasoning effort override");
            const available = candidates.map((candidate) => candidate.tier);
            const previous = states.get(key);
            const currentInfo = candidates.find((candidate) => candidate.id === previous?.model) ??
              candidates.find((candidate) => candidate.tier === "opus") ?? candidates.at(-1);
            const currentModel = currentInfo.id;
            const current = currentInfo.tier;
            const currentEffort = effortOverride ?? compatibleEffort(currentInfo, previous?.effort ?? body.reasoning?.effort);
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            let effort = currentEffort;
            if (prompt && !explaining) {
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const jev = await route({ prompt, current: currentModel, currentEffort, contextTokens, models: candidates, effortOverride });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens: previous ? contextTokens : 0,
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              const selected = candidates.find((candidate) => candidate.id === model);
              effort = effortOverride ?? compatibleEffort(selected, currentEffort);
              if (!effortOverride && decision.reason.startsWith("jev") && model === chosen?.id &&
                  Number.isFinite(jev.confidence) && jev.confidence >= THRESHOLDS.minConfidence &&
                  supportsEffort(selected, jev.effort)) effort = jev.effort;
              states.set(key, { tier, model, effort });
              routing = {
                prompt,
                tier,
                model,
                effort,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            applyCodexTier(body, tier, models, model, effort);
          } else {
            const info = codexModels(models).find((candidate) => candidate.id === body.model);
            const requestedEffort = effortOverride ?? body.reasoning?.effort;
            if (!info || (requestedEffort && !supportsEffort(info, requestedEffort))) {
              res.writeHead(400).end();
              return;
            }
            if (effortOverride) body.reasoning = { ...body.reasoning, effort: effortOverride };
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            if (prompt && !explaining) writeStatus(statusId, { manual: true, at: Date.now() });
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`codex could not process body: ${err.message}`);
          res.writeHead(400).end();
          return;
        }
      }

      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      delete headers["x-jev-session"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = addJevModel(JSON.parse(data.toString()));
                for (const model of catalog.models) models.set(model.slug, model);
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          const inspectForDecision = routing && response.statusCode >= 200 && response.statusCode < 300;
          if (inspectForDecision) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectForDecision) {
            response.pipe(res);
            return;
          }
          let pending = "";
          let inspected = false;
          response.on("data", (chunk) => {
            if (inspected) return void res.write(chunk);
            pending += chunk.toString();
            const end = pending.indexOf("\n\n");
            if (end < 0) return;
            const first = pending.slice(0, end + 2);
            res.write(first);
            const isSSE = /^(?:event|data):/m.test(first);
            if (isSSE) res.write(jevDecisionEvents(routing));
            debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
            res.write(pending.slice(end + 2));
            pending = "";
            inspected = true;
          });
          response.on("end", () => {
            if (pending) {
              debug("codex decision display skip");
              res.write(pending);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, token, close: () => server.close() };
}
