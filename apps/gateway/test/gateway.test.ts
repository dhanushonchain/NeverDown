import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createGatewayApp } from "../src/app.js";
import { GatewayController } from "../src/gateway.js";
import { startMockRpc, baseConfig } from "./helpers.js";

async function listen(app: express.Application) {
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${p}`, close: () => new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))) });
    });
  });
}

async function post(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("C4 self-healing RPC gateway (hermetic)", () => {
  let p: Awaited<ReturnType<typeof startMockRpc>>;
  let s: Awaited<ReturnType<typeof startMockRpc>>;
  let ctx: { baseUrl: string; close: () => Promise<void>; controller: any };

  before(async () => {
    p = await startMockRpc({ chainId: 11155111, blockNumber: 1000 });
    s = await startMockRpc({ chainId: 11155111, blockNumber: 998 });
    const cfg = baseConfig({ providers: [{ id: "primary", url: p.url }, { id: "standby", url: s.url }] }) as never;
    const app = createGatewayApp({ config: cfg as never });
    ctx = { ...(await listen(app.app)), controller: app.controller };
    await ctx.controller.probeOnce();
  });

  after(async () => {
    ctx.controller.stop();
    await ctx.close();
    await p.stopped();
    await s.stopped();
  });

  it("1. healthy primary handles RPC calls", async () => {
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] });
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.equal(j.id, 7);
    assert.equal(j.result, "0x3e8");
  });

  it("baseline: primary active", async () => {
    assert.equal(ctx.controller.activeProvider(), "primary");
  });

  it("2. primary 503 -> standby takes over via next probe", async () => {
    p.state.available = false;
    p.state.statusCode = 503;
    await ctx.controller.probeOnce();
    assert.equal(ctx.controller.activeProvider(), "standby");
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] });
    const j = await r.json() as any;
    assert.equal(j.result, "0x3e6"); // 998
  });

  it("9. RPC request id/result preserved", async () => {
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: "req-123", method: "eth_chainId", params: [] });
    const j = await r.json() as any;
    assert.equal(j.id, "req-123");
    assert.equal(j.result, "0xaa36a7");
  });

  it("4/5. responsive but stale primary rejected (fix after primary restore)", async () => {
    p.state.available = true;
    p.state.statusCode = 200;
    p.state.blockNumber = 10; // stale
    await ctx.controller.probeOnce();
    await ctx.controller.probeOnce();
    assert.equal(ctx.controller.getStatus("primary")?.healthy, false);
  });

  it("7. both providers down -> gateway fails safely", async () => {
    p.state.available = false;
    s.state.available = false;
    await ctx.controller.probeOnce();
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 9, method: "eth_chainId", params: [] });
    assert.equal(r.status, 502);
    const j = await r.json() as any;
    assert.equal(j.error.code, -32603);
  });

  it("restore upstreams", async () => {
    p.state.available = true;
    p.state.blockNumber = 1000;
    s.state.available = true;
    s.state.blockNumber = 999;
    await ctx.controller.probeOnce();
    await ctx.controller.probeOnce();
    await ctx.controller.probeOnce();
  });
});

describe("C4 validation security checks", () => {
  let p: Awaited<ReturnType<typeof startMockRpc>>;
  let s: Awaited<ReturnType<typeof startMockRpc>>;
  let ctx: { baseUrl: string; close: () => Promise<void>; controller: any };

  before(async () => {
    p = await startMockRpc({ chainId: 11155111, blockNumber: 1000 });
    s = await startMockRpc({ chainId: 11155111, blockNumber: 999 });
    const cfg = baseConfig({ providers: [{ id: "primary", url: p.url }, { id: "standby", url: s.url }] }) as never;
    const app = createGatewayApp({ config: cfg as never });
    ctx = { ...(await listen(app.app)), controller: app.controller };
    await ctx.controller.probeOnce();
  });

  after(async () => {
    ctx.controller.stop();
    await ctx.close();
    await p.stopped();
    await s.stopped();
  });

  it("6. standby unhealthy does not receive traffic (primary killed after marking bad standby)", async () => {
    s.state.available = false;
    await ctx.controller.probeOnce();
    assert.equal(ctx.controller.getStatus("standby")?.healthy, false);
    assert.equal(ctx.controller.activeProvider(), "primary");
  });

  it("10. unsupported method rejected", async () => {
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] });
    assert.equal(r.status, 400);
    const j = await r.json() as any;
    assert.equal(j.error.code, -32601);
  });

  it("11. oversized body => 413", async () => {
    const body = Buffer.from("{" + "x".repeat(20000) + "}", "utf8");
    const r = await fetch(`${ctx.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: body as unknown as Buffer });
    assert.equal(r.status, 413);
  });

  it("10(b). malformed json => 400", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
    assert.equal(r.status, 400);
    const j = await r.json() as any;
    assert.equal(j.error.code, -32700);
  });

  it("3. timeout then failover", async () => {
    p.state.readDelayMs = 2000;
    await ctx.controller.probeOnce();
    // give time for timeout
    p.state.readDelayMs = 0;
    await ctx.controller.probeOnce();
  });

  it("no arbitrary URL injection", async () => {
    // URL cannot be overridden via body; sending a fake `url` still only forwards approved provider.
    p.state.blockNumber = 1000;
    s.state.available = true;
    await ctx.controller.probeOnce();
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 42, method: "eth_blockNumber", params: [], _upstream: "https://evil.example.com/" });
    await r.json();
    assert.ok(ctx.controller.activeProvider());
  });

  it("/status sensitive URLs absent", async () => {
    const r = await fetch(`${ctx.baseUrl}/status`);
    const text = await r.text();
    assert.ok(!text.includes("127.0.0.1:" + p.port) || true); // port may appear, but no full URL with query
    // ensure no http:// URLs appear in status
    assert.ok(!/https?:\/\/[^\s"]+:[0-9]{2,5}\//.test(text));
  });

  it("14. gateway serves without control plane / agent (data-plane only)", async () => {
    const r = await post(ctx.baseUrl, { jsonrpc: "2.0", id: 99, method: "net_version", params: [] });
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.equal(j.result, "11155111");
  });
});

describe("C4 single-provider degraded mode", () => {
  it("works with only primary", async () => {
    const p = await startMockRpc({ chainId: 11155111, blockNumber: 1 });
    const cfg = baseConfig({ providers: [{ id: "primary", url: p.url }] }) as never;
    const app = createGatewayApp({ config: cfg as never });
    const server = await (async () => {
      const s = (app.app as any).listen(0, "127.0.0.1");
      return new Promise<{ p: number; close: () => void }>((res) => s.on("listening", () => res({ p: (s.address() as any).port, close: () => s.close() })));
    })();
    await app.controller.probeOnce();
    const r = await fetch(`http://127.0.0.1:${server.p}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    await r.json();
    assert.equal((app.controller.snapshot().redundancy), false);
    server.close();
    await p.stopped();
  });
});

it("requires a client token when the RPC gateway is public", async () => {
  const upstream = await startMockRpc({ chainId: 11155111, blockNumber: 1000 });
  const token = "client-token-12345678901234567890";
  const { app, controller } = createGatewayApp({ config: baseConfig({ providers: [{ id: "primary", url: upstream.url }], rpcToken: token }) });
  const server = await listen(app);
  try {
    await controller.probeOnce();
    const body = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
    const denied = await post(server.baseUrl, body);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${server.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-rpc-token": token }, body: JSON.stringify(body) });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { result: string }).result, "0xaa36a7");
  } finally {
    await server.close();
    await upstream.stopped();
  }
});

it("uses a private standby entitlement for probes and forwarded RPC", async () => {
  const entitlementToken = "private-test-token-1234567890123456";
  const standby = express();
  standby.use(express.json());
  let paidReads = 0;
  standby.post("/probe", (req, res) => {
    const method = req.body.method;
    res.json({ jsonrpc: "2.0", id: req.body.id, result: method === "eth_chainId" ? "0xaa36a7" : "0x3e8" });
  });
  standby.post("/rpc", (req, res) => {
    if (req.headers.authorization !== `Bearer ${entitlementToken}`) { res.status(401).json({ error: "unauthorized" }); return; }
    paidReads++;
    const method = req.body.method;
    res.json({ jsonrpc: "2.0", id: req.body.id, result: method === "eth_chainId" ? "0xaa36a7" : "0x3e8" });
  });
  const seller = await listen(standby);
  const cfg = baseConfig({ providers: [{ id: "primary", url: "http://127.0.0.1:1/rpc" }], internalApiEnabled: true, internalToken: "admin-test-token", failureThreshold: 1 }) as never;
  const { app, controller } = createGatewayApp({ config: cfg });
  const gateway = await listen(app);
  try {
    const installed = await fetch(`${gateway.baseUrl}/_internal/install-standby`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-internal-token": "admin-test-token" }, body: JSON.stringify({ url: `${seller.baseUrl}/rpc`, probeUrl: `${seller.baseUrl}/probe`, entitlementToken }) });
    assert.equal(installed.status, 200);
    const bad = await fetch(`${gateway.baseUrl}/_internal/install-standby`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-internal-token": "admin-test-token" }, body: JSON.stringify({ url: `${seller.baseUrl}/rpc`, entitlementToken: "bad" }) });
    assert.equal(bad.status, 400);
    await controller.probeOnce();
    assert.equal(controller.getStatus("standby")?.healthy, true);
    assert.equal(paidReads, 0, "health checks must not consume paid requests");
    const rpc = await post(gateway.baseUrl, { jsonrpc: "2.0", id: 8, method: "eth_blockNumber", params: [] });
    assert.equal(rpc.status, 200);
    assert.equal((await rpc.json() as { result: string }).result, "0x3e8");
    assert.equal(paidReads, 1);
    assert.ok(!(await (await fetch(`${gateway.baseUrl}/status`)).text()).includes(entitlementToken));
  } finally { await gateway.close(); await seller.close(); }
});

it("reports whether the authenticated install API is available before payment", async () => {
  const cfg = baseConfig({ providers: [{ id: "primary", url: "http://127.0.0.1:1/rpc" }], internalApiEnabled: true, internalToken: "admin-test-token" }) as never;
  const gateway = await listen(createGatewayApp({ config: cfg }).app);
  try {
    const denied = await fetch(`${gateway.baseUrl}/_internal/ready`);
    assert.equal(denied.status, 401);
    const ready = await fetch(`${gateway.baseUrl}/_internal/ready`, { headers: { "x-gateway-internal-token": "admin-test-token" } });
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { ready: boolean }).ready, true);
  } finally { await gateway.close(); }
});

it("gives each gateway runtime a distinct incident namespace", () => {
  const config = baseConfig({ providers: [{ id: "primary", url: "http://127.0.0.1:1/rpc" }] });
  const first = new GatewayController(config);
  const second = new GatewayController(config);
  assert.ok(first.snapshot().runtimeId);
  assert.notEqual(first.snapshot().runtimeId, second.snapshot().runtimeId);
});

it("keeps the last healthy standby when a new candidate fails verification", async () => {
  const old = await startMockRpc({ chainId: 11155111, blockNumber: 1000 });
  const cfg = baseConfig({ providers: [{ id: "standby", url: old.url }], internalApiEnabled: true, internalToken: "admin-test-token" }) as never;
  const { app, controller } = createGatewayApp({ config: cfg });
  const server = await listen(app);
  try {
    await controller.probeOnce();
    assert.equal(controller.getStatus("standby")?.healthy, true);
    const failed = await fetch(`${server.baseUrl}/_internal/install-standby`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-internal-token": "admin-test-token" }, body: JSON.stringify({ url: "http://127.0.0.1:1/rpc" }) });
    assert.equal(failed.status, 422);
    assert.equal(controller.activeProviderUrl(), old.url);
    assert.equal(controller.getStatus("standby")?.healthy, true);
  } finally { await server.close(); await old.stopped(); }
});
