import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import type { SellerConfig } from "../src/config.js";

export const TEST_MERCHANT = "0.0.4242";
export const TEST_ASSET = "0.0.0";
export const TEST_PRICE = "10000";
export const TEST_FEE_PAYER = "0.0.9185802";

export function testConfig(overrides: Partial<SellerConfig> = {}): SellerConfig {
  return {
    port: 0,
    network: "hedera:testnet",
    merchantAccountId: TEST_MERCHANT,
    assetId: TEST_ASSET,
    priceSmallestUnits: TEST_PRICE,
    facilitatorUrl: "http://localhost:9",
    rpcMode: "mock",
    rpcUpstreamUrl: null,
    entitlementDbPath: ":memory:",
    databaseUrl: null,
    trustProxy: false,
    ...overrides,
  };
}

// Test double for the facilitator. Unit tests only; this is NOT Hedera settlement.
export function fakeFacilitator(): FacilitatorClient & { verifyCalls: number; settleCalls: number } {
  const fake = {
    verifyCalls: 0,
    settleCalls: 0,
    async getSupported() {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: TEST_FEE_PAYER },
          },
        ],
        extensions: [],
        signers: { "hedera:*": [TEST_FEE_PAYER] },
      };
    },
    async verify() {
      fake.verifyCalls += 1;
      return { isValid: false, invalidReason: "fake facilitator rejects all payments" };
    },
    async settle(): Promise<never> {
      fake.settleCalls += 1;
      throw new Error("settle is not part of C1 and must not be reached");
    },
  };
  return fake as unknown as FacilitatorClient & { verifyCalls: number; settleCalls: number };
}

export async function listen(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function decodePaymentRequired(headerValue: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as Record<string, unknown>;
}
