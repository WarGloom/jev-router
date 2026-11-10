import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJevModel,
  applyCodexTier,
  codexConversationKey,
  codexModels,
  codexNewTurnPrompt,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  startCodexProxy,
  upstreamFor,
} from "../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill } from "../src/codex-cli.mjs";
import { readStatus } from "../src/status.mjs";

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-6.1-sol"]).filter((a) => a === "--model").length, 1);
});

test("installs the bundled explanation skill for Codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = installCodexSkill(home);
  assert.match(target, /jev-router-explain[\\/]SKILL\.md$/);
  assert.match(readFileSync(target, "utf8"), /name: jev-explain/);
});

test("reads only fresh Codex user turns", () => {
  const body = {
    input: [
      { type: "additional_tools", role: "developer", tools: [{}] },
      { role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { role: "user", content: [{ type: "input_text", text: "<system_reminder>tools</system_reminder>" }] },
      {
        role: "user",
        content: "<environment_context><current_date>2026-09-17</current_date></environment_context>",
      },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Fix the bug");
  body.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(body), null);
  assert.equal(
    codexNewTurnPrompt({
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
    null,
  );
  assert.equal(isCodexAuxiliaryPrompt("Generate a concise, single-line task title of at most 36 characters"), true);
});

test("keeps sub-agent routing state separate", () => {
  const base = { input: [{ role: "user", content: "same prompt" }] };
  assert.notEqual(
    codexConversationKey({ ...base, prompt_cache_key: "main" }),
    codexConversationKey({ ...base, prompt_cache_key: "sub-agent" }),
  );
});

test("adds Jev Router to the native model catalog", () => {
  const catalog = addJevModel({
    models: [{
      slug: "gpt-6.1-terra",
      display_name: "GPT-6.1-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.equal(catalog.models[0].slug, "jev-router");
  assert.equal(catalog.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[1].slug, "gpt-6.1-terra");
});

test("routes subscription auth to ChatGPT and API keys to the public API", () => {
  assert.equal(
    upstreamFor({ "chatgpt-account-id": "acct" }, "/responses"),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/responses"), "https://api.openai.com/v1");
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/models"), "https://chatgpt.com/backend-api/codex");
});

test("maps tiers and clamps unsupported reasoning effort", () => {
  const body = { model: "jev-router", reasoning: { effort: "max" } };
  const models = new Map([[
    "gpt-6-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-6.1-terra", { slug: "gpt-6.1-terra", display_name: "GPT-6.1-Terra" }],
    ["gpt-6.1-sol", { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-6-luna", tier: "haiku" },
    { id: "gpt-6.1-terra", tier: "sonnet" },
    { id: "gpt-6.1-sol", tier: "opus" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-6\.1-sol/);
  assert.match(events, /confidence in recommendation: 91%/);

  const fallback = jevDecisionEvents({
    tier: "sonnet", effort: "low", confidence: 0.25,
    reason: "low-confidence-fallback/no-change",
    jev: { response: { answers: { model: { choice: "gpt-6-luna" } } } },
    reasoningDecision: { source: "jev", confidence: 0.85 },
  });
  assert.match(fallback, /routed this turn to gpt-6\.1-terra \(low\)/);
  assert.match(fallback, /Jev model recommendation: gpt-6-luna \(confidence in recommendation: 25%\)/);
  assert.match(fallback, /Policy: low-confidence fallback; kept current model/);
  assert.match(fallback, /confidence in effort recommendation: 85%/);

  const unavailable = jevDecisionEvents({
    tier: "sonnet",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /api_key_file in ~\/\.config\/jev-router\/config\.json/);
  assert.match(unavailable, /using gpt-6\.1-terra/);
});

test("proxy preserves Codex auth, picker, routing, and native decision output", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        session: req.headers["x-jev-session"],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          models: [{
            slug: "gpt-6.1-terra",
            display_name: "GPT-6.1-Terra",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-6.1-sol",
            display_name: "GPT-6.1-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const statusId = `codex-test-${process.pid}`;
  let routeCalls = 0;
  const { port, token, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ models, selection }) => {
      routeCalls++;
      assert.deepEqual(models.map((model) => model.id), selection === "effort"
        ? ["gpt-6.1-sol"] : ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"]);
      return {
        choice: "gpt-6.1-sol",
        effort: "high",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-6.1-sol", confidence: 0.91 } } },
        metrics: {
          taskComplexity: 0.82,
          reasoningRequired: 0.91,
          toolComplexity: 0.64,
          contextSize: 0.31,
        },
      };
    },
    statusId,
  });
  t.after(close);
  const headers = { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct", "x-jev-session": token };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.equal(catalog.models[0].slug, "jev-router");

  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[0].session, undefined);
  assert.equal(seen[1].session, undefined);
  assert.equal(seen[1].body.model, "gpt-6.1-sol");
  assert.equal(seen[1].body.reasoning.effort, "high");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-6.1-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
  });
  assert.equal(routeCalls, 2);
  assert.equal(readStatus(statusId).confidence, 0.91);
  assert.equal(readStatus(statusId).history.length, 1);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [{ role: "user", content: [{ type: "input_text", text: "$jev-explain" }] }],
    }),
  });
  assert.equal(routeCalls, 2);
  assert.equal(seen[3].body.model, "gpt-6.1-sol");
  assert.equal(seen[3].body.reasoning.effort, "high");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
});


test("proxy rejects unauthenticated, browser, Astra and oversized requests", async (t) => {
  const dumpDir = mkdtempSync(join(tmpdir(), "jev-no-dump-"));
  const oldDump = process.env.JEV_DUMP;
  process.env.JEV_DUMP = join(dumpDir, "body");
  t.after(() => {
    if (oldDump === undefined) delete process.env.JEV_DUMP;
    else process.env.JEV_DUMP = oldDump;
    rmSync(dumpDir, { recursive: true, force: true });
  });
  let forwarded = 0;
  const upstream = http.createServer((req, res) => {
    forwarded++;
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const { port, token, close } = await startCodexProxy({ apiBaseURL: base, chatgptBaseURL: base });
  t.after(close);
  const url = `http://127.0.0.1:${port}/responses`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { "x-jev-session": "wrong" } })).status, 403);
  assert.equal((await fetch(url, { headers: { "x-jev-session": token, origin: "https://example.com" } })).status, 403);
  const headers = { "x-jev-session": token, "content-type": "application/json" };
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "GPT-6-AStRa" }) })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-6-astra" }) })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(32 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(forwarded, 0);
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol" }) })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-6-luna", reasoning: { effort: "ultra" } }) })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-6-luna", reasoning: { effort: "high" } }) })).status, 200);
  assert.equal(forwarded, 1);
  assert.deepEqual(readdirSync(dumpDir), []);
});

test("Astra is excluded from catalog and environment overrides", () => {
  const old = process.env.JEV_CODEX_STRONG_MODEL;
  try {
    process.env.JEV_CODEX_STRONG_MODEL = "gPt-6-AsTrA";
    const catalog = addJevModel({ models: [
      { slug: "gpt-6-ASTRA", visibility: "list" },
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-6.1-terra", visibility: "list" },
    ] });
    assert.deepEqual(catalog.models.map((m) => m.slug), ["jev-router", "gpt-6.1-terra"]);
    const candidates = codexModels(new Map([["gpt-6-astra", { slug: "gpt-6-astra" }]]));
    assert.deepEqual(candidates.map((m) => m.id), ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"]);
  } finally {
    if (old === undefined) delete process.env.JEV_CODEX_STRONG_MODEL;
    else process.env.JEV_CODEX_STRONG_MODEL = old;
  }
});


test("effort override limits auto candidates and rejects incompatible manual requests", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let options;
  const { port, token, close } = await startCodexProxy({
    apiBaseURL: base, effortOverride: "ultra",
    route: async (input) => { options = input; return { choice: "gpt-6.1-terra", effort: "ultra", confidence: 0.9 }; },
  });
  t.after(close);
  const url = `http://127.0.0.1:${port}/responses`;
  const headers = { "x-jev-session": token, "content-type": "application/json" };
  const input = [{ type: "additional_tools" }, { role: "user", content: "make a change" }];
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "jev-router", input }) })).status, 200);
  assert.deepEqual(options.models.map((model) => model.id), ["gpt-6.1-terra", "gpt-6.1-sol"]);
  assert.equal(options.effortOverride, "ultra");
  assert.equal(seen[0].reasoning.effort, "ultra");
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-6-luna" }) })).status, 400);
});


test("uncertain model fallback asks Jev for the final model's reasoning effort", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let turn = 0;
  const routedEffortModels = [];
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const { port, token, close } = await startCodexProxy({
    apiBaseURL: base,
    route: async ({ models }) => {
      if (models.length === 1) {
        routedEffortModels.push(models[0].id);
        return { choice: models[0].id, effort: turn === 1 ? "high" : "low", confidence: 0.9 };
      }
      turn++;
      return turn === 1
        ? { choice: "gpt-6-luna", effort: "low", confidence: 0.1 }
        : { choice: "gpt-6.1-terra", effort: "low", confidence: 0.9 };
    },
  });
  t.after(close);
  const url = `http://127.0.0.1:${port}/responses`;
  const headers = { "x-jev-session": token, "content-type": "application/json" };
  const request = (text) => ({ model: "jev-router", prompt_cache_key: "same", reasoning: { effort: "high" }, input: [
    { type: "additional_tools" }, { role: "user", content: text },
  ] });
  for (const text of ["simple", "x".repeat(81000)]) {
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(request(text)) })).status, 200);
  }
  assert.deepEqual(seen.map((body) => [body.model, body.reasoning.effort]), [
    ["gpt-6.1-terra", "high"], ["gpt-6.1-terra", "low"],
  ]);
  assert.deepEqual(routedEffortModels, ["gpt-6.1-terra", "gpt-6.1-terra"]);
});


test("fresh Jev effort choice wins over the initial choice after a model change", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const calls = [];
  const { port, token, close } = await startCodexProxy({
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async (input) => {
      calls.push(input.models.map((model) => model.id));
      return input.models.length === 1
        ? { choice: "gpt-6-luna", effort: "medium", confidence: 0.9 }
        : { choice: "gpt-6-luna", effort: "low", confidence: 0.9 };
    },
  });
  t.after(close);
  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "x-jev-session": token, "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", input: [
      { type: "additional_tools" }, { role: "user", content: "moderately complex debugging" },
    ] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"],
    ["gpt-6-luna"],
  ]);
  assert.equal(seen[0].model, "gpt-6-luna");
  assert.equal(seen[0].reasoning.effort, "medium");
});

for (const includePreviousExchange of [false, true]) {
  test(`follow-up effort selection with context sharing ${includePreviousExchange ? "enabled" : "disabled"}`, async (t) => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());
    const calls = [];
    let effortCalls = 0;
    const { port, token, close } = await startCodexProxy({
      includePreviousExchange,
      apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
      route: async (options) => {
        calls.push(options);
        return options.models.length === 1
          ? { choice: "gpt-6.1-terra", effort: ++effortCalls === 1 ? "high" : "medium", confidence: 0.9 }
          : { choice: "gpt-6.1-terra", confidence: 0.9 };
      },
    });
    t.after(close);
    const input = [
      { type: "additional_tools" },
      { role: "developer", content: "private developer instructions" },
      { role: "user", content: "Find the cause of retries losing updates." },
      { role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "private reasoning" }] },
      { type: "function_call_output", output: "private tool output" },
      { role: "assistant", content: [{ type: "output_text", text: "The root cause is still uncertain across the API and worker." }] },
      { role: "assistant", content: [{ type: "output_text", text: "[Jev] routed this turn to a model." }] },
      { role: "user", content: "Fix it." },
    ];
    const send = () => fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST", headers: { "x-jev-session": token, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-router", prompt_cache_key: "context-check", input }),
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.deepEqual(calls[0].previousExchange, includePreviousExchange ? [
      { role: "user", text: "Find the cause of retries losing updates." },
      { role: "assistant", text: "The root cause is still uncertain across the API and worker." },
    ] : []);
    assert.equal(calls[0].selection, "model");
    assert.equal(calls[1].selection, "effort");
    assert.equal(effortCalls, 2);
    assert.deepEqual(seen.map((body) => body.reasoning.effort), ["high", "medium"]);
  });
}

test("large first and subsequent turns can downgrade model and effort", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { seen.push(JSON.parse(Buffer.concat(chunks))); res.end("ok"); });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const contexts = [];
  const routedEffortModels = [];
  let turns = 0;
  const { port, token, close } = await startCodexProxy({
    apiBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ contextTokens, models }) => {
      contexts.push(contextTokens);
      if (models.length === 1) {
        routedEffortModels.push(models[0].id);
        return { choice: models[0].id, effort: "low", confidence: 0.92 };
      }
      turns++;
      return { choice: turns === 2 ? "gpt-6.1-sol" : "gpt-6-luna", effort: "low", confidence: 0.92 };
    },
  });
  t.after(close);
  const headers = { "x-jev-session": token, "content-type": "application/json" };
  const send = (key) => fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST", headers, body: JSON.stringify({ model: "jev-router", prompt_cache_key: key,
      input: [{ type: "additional_tools" }, { role: "user", content: "x".repeat(81000) }] }),
  });
  assert.equal((await send("fresh")).status, 200);
  assert.equal(seen[0].model, "gpt-6-luna");
  assert.equal(seen[0].reasoning.effort, "low");
  assert(contexts[0] > 20000);
  assert.equal((await send("cached")).status, 200);
  assert.equal(seen[1].model, "gpt-6.1-sol");
  assert.equal((await send("cached")).status, 200);
  assert.equal(seen[2].model, "gpt-6-luna");
  assert.equal(seen[2].reasoning.effort, "low");
  assert(contexts[2] > 20000);
  assert.deepEqual(routedEffortModels, ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-luna"]);
});
