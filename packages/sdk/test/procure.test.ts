import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNeverDownClient } from "../src/client.js";
import type { CapabilityOfferRow } from "@neverdown/core";

const base = "https://seller.example";
const offer: CapabilityOfferRow = {
  entityKey: "0xoffer", sellerens: "seller.eth", serviceurl: base,
  schemaversion: 2n, probeurl: `${base}/probe`, purchaseurl: `${base}/rpc-pack`, rpcurl: `${base}/rpc`,
  pricetinybars: 10000n, chainid: 11155111n, category: "rpc", payto: "0.0.123",
  expiresat: new Date(Date.now() + 60_000).toISOString(),
};

function setup(overrides: Record<string, unknown> = {}) {
  const requests: unknown[] = [];
  let closed = false;
  let installed = false;
  const ports = {
    resolve: async () => ({ ensName: "seller.eth", normalizedEnsName: "seller.eth", address: null, resolverAddress: null, records: { hederaAccount: "0.0.123", x402Url: base } }),
    discover: async () => [offer],
    prove: async () => ({ pass: true, checks: [] }),
    worker: () => ({ requestPurchase: async (request: unknown) => {
      requests.push(request);
      return { status: "SETTLED", purchaseId: "incident-1", transactionId: "0.0.1@123.456", hashscanUrl: "https://hashscan.io/testnet/transaction/tx", auditStatus: "published", entitlementToken: "private-entitlement-token" };
    }, close: () => { closed = true; } }),
    fetchImpl: async (_url: string, init: { headers?: Record<string, string>; body?: string }) => {
      assert.equal(init.headers?.["x-gateway-internal-token"], "gateway-token-1234567890");
      const body = JSON.parse(String(init.body)) as { entitlementToken: string };
      assert.equal(body.entitlementToken, "private-entitlement-token");
      installed = true;
      return { ok: true, json: async () => ({ installed: true }) };
    },
    ...overrides,
  };
  const client = createNeverDownClient({ env: {
    ENS_RPC_URL: "https://eth.example", ENS_ALLOWLIST_NAMES: "seller.eth", POC_REFERENCE_RPC: "https://ref.example",
    PAYMENT_WORKER_ENV_FILE: "/tmp/worker.env", GATEWAY_URL: "http://localhost:8787", GATEWAY_INTERNAL_TOKEN: "gateway-token-1234567890",
  } }, ports as never);
  return { client, requests, get closed() { return closed; }, get installed() { return installed; } };
}

describe("worker-backed procurement", () => {
  it("verifies, settles via worker, installs token, and redacts the receipt", async () => {
    const ctx = setup();
    const result = await ctx.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer });
    assert.equal(result.status, "SETTLED");
    assert.equal(result.installed, true);
    assert.equal(result.transactionId, "0.0.1@123.456");
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.closed, true);
    assert.equal(ctx.installed, true);
    assert.equal(JSON.stringify(result).includes("private-entitlement-token"), false);
  });

  it("denies an offer whose ENS endpoint differs without starting a worker", async () => {
    const ctx = setup();
    await assert.rejects(ctx.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer: { ...offer, serviceurl: "https://evil.example" } }), /matching Arkiv entity|offer endpoint|offer URLs/i);
    assert.equal(ctx.requests.length, 0);
  });

  it("keeps denial and settled-install-failure outcomes without exposing a token", async () => {
    const denied = setup({ worker: () => ({ requestPurchase: async () => ({ status: "DENIED", purchaseId: "incident-1", denyReason: "RECIPIENT_NOT_ALLOWLISTED", message: "denied", auditStatus: "published" }), close: () => {} }) });
    const denial = await denied.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer });
    assert.equal(denial.status, "DENIED");
    assert.equal(denial.installed, false);
    const failed = setup({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "gateway down" }) }) });
    const receipt = await failed.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer });
    assert.equal(receipt.status, "SETTLED");
    assert.equal(receipt.installed, false);
    assert.equal(receipt.transactionId, "0.0.1@123.456");
    assert.equal(JSON.stringify(receipt).includes("private-entitlement-token"), false);
  });

  it("preserves the transaction when the worker reports settlement without a token", async () => {
    const ctx = setup({ worker: () => ({ requestPurchase: async () => ({ status: "SETTLED", transactionId: "0.0.1@123.456", hashscanUrl: "https://hashscan.io/testnet/transaction/tx", auditStatus: "published" }), close: () => {} }) });
    const receipt = await ctx.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer });
    assert.equal(receipt.status, "SETTLED");
    assert.equal(receipt.installed, false);
    assert.equal(receipt.transactionId, "0.0.1@123.456");
  });

  it("reports worker transport failure as uncertain instead of inviting a retry", async () => {
    const ctx = setup({ worker: () => ({ requestPurchase: async () => { throw new Error("worker disconnected"); }, close: () => {} }) });
    const receipt = await ctx.client.procure({ incidentId: "incident-1", serviceId: "rpc-main", offer });
    assert.equal(receipt.status, "UNCERTAIN");
    assert.equal(receipt.installed, false);
  });
});
