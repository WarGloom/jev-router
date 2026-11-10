import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { startCodexProxy } from "../src/codex-proxy.mjs";

async function fixture(t, route) {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    res.once("close", resolveUpstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: waiting\n\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startCodexProxy({ apiBaseURL: `http://127.0.0.1:${upstream.address().port}`, ...(route ? { route } : {}) });
  const requests = [];
  t.after(() => {
    for (const request of requests) request.destroy();
    const server = proxy.close();
    server?.closeAllConnections();
    upstream.closeAllConnections();
    upstream.close();
  });
  const send = (model = "gpt-6.1-sol") => {
    const request = http.request({
      hostname: "127.0.0.1", port: proxy.port, path: "/responses", method: "POST",
      headers: { "x-jev-session": proxy.token, "content-type": "application/json" },
    });
    request.on("error", () => {});
    requests.push(request);
    request.end(JSON.stringify({ model, input: [{ type: "additional_tools" }, { role: "user", content: "diagnose a race" }] }));
    return request;
  };
  const openStream = async (model) => {
    const request = send(model);
    const [response] = await once(request, "response");
    response.on("error", () => {});
    await once(response, "data");
    return { request, response };
  };
  return { proxy, send, openStream, upstreamClosed, upstreamRequests: () => upstreamRequests };
}

test("disconnecting Codex cancels its routed upstream stream", { timeout: 2000 }, async (t) => {
  const f = await fixture(t, async () => ({ choice: "gpt-6.1-sol", effort: "high", confidence: 0.95 }));
  const { request, response } = await f.openStream("jev-router");
  response.destroy();
  request.destroy();
  await f.upstreamClosed;
  assert.equal(f.upstreamRequests(), 1);
});

test("proxy shutdown closes an active stream and is idempotent", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const { response } = await f.openStream();
  const downstreamClosed = new Promise((resolve) => response.once("close", resolve));
  const server = f.proxy.close();
  const listenerClosed = once(server, "close");
  assert.equal(f.proxy.close(), server);
  await Promise.all([f.upstreamClosed, downstreamClosed, listenerClosed]);
  assert.equal(server.listening, false);
});

for (const pendingSelection of ["model", "effort"]) {
  test(`shutdown aborts pending ${pendingSelection} routing without forwarding`, { timeout: 2000 }, async (t) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let entered;
    const routingEntered = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    const f = await fixture(t, async (options) => {
      calls.push(options);
      if (options.selection === pendingSelection) {
        entered(options);
        return pending;
      }
      return { choice: "gpt-6.1-sol", confidence: 0.95 };
    });
    t.after(() => release({ choice: "gpt-6.1-sol", effort: "high", confidence: 0.95 }));
    f.send("jev-router");
    const options = await routingEntered;
    const server = f.proxy.close();
    const listenerClosed = once(server, "close");
    assert.equal(options.signal?.aborted, true);
    release({ choice: "gpt-6.1-sol", effort: "high", confidence: 0.95 });
    await listenerClosed;
    await setImmediate();
    assert.equal(f.upstreamRequests(), 0);
    assert.equal(calls.length, pendingSelection === "model" ? 1 : 2);
  });
}
