import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNeverDownClient } from "../src/client.js";
import type { CapabilityOfferRow } from "@neverdown/core";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

it("procures through a real compiled worker and denies a mismatched recipient without signing", async () => {
  let paidRequests = 0;
  let base = "";
  const server = createServer((req, res) => {
    if (req.url !== "/rpc-pack") { res.writeHead(404).end(); return; }
    if (req.headers["payment-signature"]) {
      paidRequests += 1;
      res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encode({ success: true, transaction: "0.0.1@123.456", network: "hedera:testnet" }) });
      res.end(JSON.stringify({ token: "settled-pack-token-1234567890123456", maxRequests: 100 }));
      return;
    }
    res.writeHead(402, { "Payment-Required": encode({
      x402Version: 2, resource: { url: `${base}/rpc-pack`, mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "10000", asset: "0.0.0", payTo: "0.0.4242", maxTimeoutSeconds: 60, extra: { feePayer: "0.0.1111" } }],
    }) });
    res.end(JSON.stringify({ error: "Payment required" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "nd-sdk-worker-"));
  const envFile = join(dir, ".env.worker");
  const workerEnv = [
    "HEDERA_NETWORK=testnet", "HEDERA_SPEND_ID=0.0.1111", `HEDERA_SPEND_KEY=${"a".repeat(64)}`,
    "HEDERA_X402_ASSET_ID=0.0.0", "POLICY_ALLOWLIST=0.0.4242", "POLICY_SERVICES=rpc-main",
    `POLICY_ENDPOINTS=${base}`, `POLICY_DB_PATH=${join(dir, "policy.sqlite")}`,
    "POLICY_TOTAL_BUDGET_TINYBARS=30000", "POLICY_MAX_PER_PAYMENT_TINYBARS=10000",
    "HCS_AUDIT_AVAILABILITY=BEST_EFFORT",
  ];
  writeFileSync(envFile, workerEnv.join("\n"), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const offer: CapabilityOfferRow = {
    entityKey: "0xabc", sellerens: "seller.eth", serviceurl: base, schemaversion: 2n,
    probeurl: `${base}/probe`, purchaseurl: `${base}/rpc-pack`, rpcurl: `${base}/rpc`,
    pricetinybars: 10000n, chainid: 11155111n, category: "rpc", payto: "0.0.4242",
    expiresat: new Date(Date.now() + 60_000).toISOString(),
  };
  const ports = {
    resolve: async (_name: string, payTo: string) => ({ ensName: "seller.eth", normalizedEnsName: "seller.eth", address: null, resolverAddress: null, records: { hederaAccount: payTo, x402Url: base } }),
    discover: async () => [offer],
    prove: async () => ({ pass: true, checks: [] }),
    fetchImpl: async (_url: string, init: { method: string }) => init.method === "GET"
      ? { ok: true, json: async () => ({ ready: true }) }
      : { ok: true, json: async () => ({ installed: true }) },
  };
  const client = createNeverDownClient({ env: {
    ENS_RPC_URL: "https://eth.example", ENS_ALLOWLIST_NAMES: "seller.eth", POC_REFERENCE_RPC: "https://reference.example",
    PAYMENT_WORKER_ENV_FILE: envFile, GATEWAY_URL: "http://localhost:8787", GATEWAY_INTERNAL_TOKEN: "gateway-token-1234567890",
  } }, ports as never);
  try {
    const good = await client.procure({ incidentId: "sdk-integration-good", serviceId: "rpc-main", offer });
    assert.equal(good.status, "SETTLED");
    assert.equal(good.installed, true);
    assert.equal(good.transactionId, "0.0.1@123.456");
    assert.equal(paidRequests, 1);
    const wrong = { ...offer, payto: "0.0.9999" };
    ports.discover = async () => [wrong];
    const denied = await client.procure({ incidentId: "sdk-integration-deny", serviceId: "rpc-main", offer: wrong });
    assert.equal(denied.status, "DENIED");
    assert.equal(paidRequests, 1);
  } finally {
    server.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // Windows can keep a brief lock on SQLite temp dirs after the worker exits.
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") {
        throw error;
      }
    }
  }
});
