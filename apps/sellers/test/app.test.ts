import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import {
  decodePaymentRequired,
  fakeFacilitator,
  listen,
  testConfig,
  TEST_ASSET,
  TEST_FEE_PAYER,
  TEST_MERCHANT,
  TEST_PRICE,
} from "./helpers.js";

const VALID_RPC = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };

type Ctx = {
  baseUrl: string;
  close: () => Promise<void>;
  executed: string[];
  facilitator: ReturnType<typeof fakeFacilitator>;
  upstreamCalls: number;
};

async function start(): Promise<Ctx> {
  const executed: string[] = [];
  const facilitator = fakeFacilitator();
  const counters = { upstreamCalls: 0 };
  const app = createApp({
    config: testConfig({ rpcMode: "upstream", rpcUpstreamUrl: "https://rpc.example.com/" }),
    facilitatorClient: facilitator,
    onExecute: (method) => executed.push(method),
    fetchImpl: (async () => {
      counters.upstreamCalls += 1;
      throw new Error("upstream must not be called without payment");
    }) as typeof fetch,
  });
  const srv = await listen(app);
  return { ...srv, executed, facilitator, get upstreamCalls() { return counters.upstreamCalls; } };
}

async function post(ctx: Ctx, body: string | object, headers: Record<string, string> = {}) {
  return fetch(`${ctx.baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("C1 x402 RPC seller", () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await start();
  });
  after(async () => {
    await ctx.close();
  });

  it("Test A: GET /health is public and returns 200", async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      service: "neverdown-rpc-seller",
      network: "hedera:testnet",
    });
  });

  it("Test B: unauthenticated POST /rpc returns 402 with a payment challenge header", async () => {
    const res = await post(ctx, VALID_RPC);
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"), "PAYMENT-REQUIRED header must be present");
  });

  it("quotes the public HTTPS resource URL behind a trusted Heroku proxy", async () => {
    const proxy = await listen(createApp({ config: testConfig({ trustProxy: true }), facilitatorClient: fakeFacilitator() }));
    try {
      const res = await fetch(`${proxy.baseUrl}/rpc-pack`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: "{}",
      });
      assert.equal(res.status, 402);
      const challenge = decodePaymentRequired(res.headers.get("payment-required")!) as { resource: { url: string } };
      assert.equal(challenge.resource.url, proxy.baseUrl.replace("http:", "https:") + "/rpc-pack");
    } finally { await proxy.close(); }
  });

  it("serves only bounded public capability probes without payment", async () => {
    const app = createApp({ config: testConfig(), facilitatorClient: fakeFacilitator() });
    const probe = await listen(app);
    try {
      for (const [method, params] of [["eth_chainId", []], ["eth_blockNumber", []], ["eth_getBlockByNumber", ["latest", false]]] as const) {
        const res = await fetch(`${probe.baseUrl}/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        assert.equal(res.status, 200);
        assert.ok((await res.json() as { result?: unknown }).result);
      }
      const forbidden = await fetch(`${probe.baseUrl}/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "net_version", params: [] }) });
      assert.equal(forbidden.status, 400);
      for (let i = 3; i < 120; i++) {
        const res = await fetch(`${probe.baseUrl}/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] }) });
        assert.equal(res.status, 200);
      }
      const limited = await fetch(`${probe.baseUrl}/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 121, method: "eth_chainId", params: [] }) });
      assert.equal(limited.status, 429);
      const paid = await fetch(`${probe.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID_RPC) });
      assert.equal(paid.status, 402);
    } finally { await probe.close(); }
  });

  it("quotes a pack purchase and rejects unissued bearer credentials", async () => {
    const pack = await fetch(`${ctx.baseUrl}/rpc-pack`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(pack.status, 402);
    assert.ok(pack.headers.get("payment-required"));
    const bearer = await post(ctx, VALID_RPC, { authorization: "Bearer invented" });
    assert.equal(bearer.status, 401);
    assert.equal(ctx.upstreamCalls, 0);
  });

  it("activates a bounded credential only after fake facilitator settlement", async () => {
    const facilitator = fakeFacilitator();
    facilitator.verify = async () => ({ isValid: true, payer: "0.0.1111" });
    facilitator.settle = async () => ({ success: true, transaction: "0.0.1111@1700000000.000000001", network: "hedera:testnet" });
    const app = createApp({ config: testConfig(), facilitatorClient: facilitator });
    const srv = await listen(app);
    try {
      const unpaid = await fetch(`${srv.baseUrl}/rpc-pack`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(unpaid.status, 402);
      const challenge = decodePaymentRequired(unpaid.headers.get("payment-required")!) as { resource: unknown; accepts: unknown[] };
      const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { transaction: "AAAA" } })).toString("base64");
      const paid = await fetch(`${srv.baseUrl}/rpc-pack`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": signature }, body: "{}" });
      assert.equal(paid.status, 200);
      const { token } = await paid.json() as { token: string };
      assert.ok(token);
      for (let i = 0; i < 100; i++) {
        const rpc = await fetch(`${srv.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(VALID_RPC) });
        assert.equal(rpc.status, 200, `request ${i}`);
      }
      const exhausted = await fetch(`${srv.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(VALID_RPC) });
      assert.equal(exhausted.status, 401);
    } finally { await srv.close(); }
  });

  it("keeps a settled pack usable after a seller restart with PostgreSQL", async (t) => {
    const databaseUrl = process.env.TEST_POSTGRES_URL;
    if (!databaseUrl) { t.skip("set TEST_POSTGRES_URL to run the PostgreSQL integration test"); return; }
    const facilitator = fakeFacilitator();
    facilitator.verify = async () => ({ isValid: true, payer: "0.0.1111" });
    facilitator.settle = async () => ({ success: true, transaction: "0.0.1111@1700000000.000000001", network: "hedera:testnet" });
    const config = testConfig({ databaseUrl });
    const first = await listen(createApp({ config, facilitatorClient: facilitator }));
    let token: string;
    try {
      const unpaid = await fetch(`${first.baseUrl}/rpc-pack`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(unpaid.status, 402);
      const challenge = decodePaymentRequired(unpaid.headers.get("payment-required")!) as { resource: unknown; accepts: unknown[] };
      const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { transaction: "AAAA" } })).toString("base64");
      const paid = await fetch(`${first.baseUrl}/rpc-pack`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": signature }, body: "{}" });
      assert.equal(paid.status, 200);
      token = (await paid.json() as { token: string }).token;
    } finally { await first.close(); }
    const restarted = await listen(createApp({ config, facilitatorClient: facilitator }));
    try {
      const rpc = await fetch(`${restarted.baseUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token!}` }, body: JSON.stringify(VALID_RPC) });
      assert.equal(rpc.status, 200);
    } finally { await restarted.close(); }
  });

  it("Test C: the decoded challenge advertises the configured Hedera testnet exact payment", async () => {
    const res = await post(ctx, VALID_RPC);
    const challenge = decodePaymentRequired(res.headers.get("payment-required")!) as {
      x402Version: number;
      resource?: { url?: string };
      accepts: Array<Record<string, unknown>>;
    };
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts.length, 1);
    const option = challenge.accepts[0];
    assert.equal(option.scheme, "exact");
    assert.equal(option.network, "hedera:testnet");
    assert.equal(option.payTo, TEST_MERCHANT);
    assert.equal(option.asset, TEST_ASSET);
    assert.equal(option.amount, TEST_PRICE);
    assert.equal(typeof option.maxTimeoutSeconds, "number");
    assert.ok((option.maxTimeoutSeconds as number) > 0);
    assert.equal((option.extra as { feePayer?: string }).feePayer, TEST_FEE_PAYER);
    assert.ok(challenge.resource?.url?.endsWith("/rpc"), "resource url should point at /rpc");
  });

  it("Test D: unpaid requests never reach the RPC handler or upstream", async () => {
    const before = ctx.executed.length;
    await post(ctx, VALID_RPC);
    await post(ctx, VALID_RPC);
    assert.equal(ctx.executed.length, before);
    assert.equal(ctx.upstreamCalls, 0);
  });

  it("Test E: malformed or disallowed JSON-RPC is rejected before payment and never executes", async () => {
    const cases: Array<string | object> = [
      "{not json",
      [VALID_RPC, VALID_RPC],
      { id: 1, method: "eth_blockNumber" },
      { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] },
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: ["latest"] },
      { jsonrpc: "2.0", method: "eth_blockNumber" },
    ];
    const executedBefore = ctx.executed.length;
    const verifyBefore = ctx.facilitator.verifyCalls;
    for (const body of cases) {
      const res = await post(ctx, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const json = (await res.json()) as { error: { code: number } };
      assert.ok(json.error.code < 0);
    }
    assert.equal(ctx.executed.length, executedBefore);
    assert.equal(ctx.facilitator.verifyCalls, verifyBefore, "invalid requests must not reach the facilitator");
  });

  it("Test G: fake payment headers or payloads do not grant access", async () => {
    const executedBefore = ctx.executed.length;
    const fakeBase64 = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0xdead" } })).toString("base64");
    const variants: Record<string, string>[] = [
      { "x-payment": "paid" },
      { "payment-signature": "bogus" },
      { "payment-signature": fakeBase64 },
      { "x-neverdown-paid": "true" },
    ];
    for (const headers of variants) {
      const res = await post(ctx, VALID_RPC, headers);
      assert.notEqual(res.status, 200, `fake payment ${JSON.stringify(headers)} must not succeed`);
      assert.equal(res.status, 402);
    }
    assert.equal(ctx.executed.length, executedBefore);
  });
});
