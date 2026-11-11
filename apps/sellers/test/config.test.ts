import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { HEDERA_MERCHANT_ACCOUNT_ID: "0.0.4242" };

describe("loadConfig (Test F: configuration safety)", () => {
  it("applies safe defaults when only the merchant account is set", () => {
    const cfg = loadConfig({ ...base });
    assert.equal(cfg.port, 4001);
    assert.equal(cfg.network, "hedera:testnet");
    assert.equal(cfg.assetId, "0.0.0");
    assert.equal(cfg.priceSmallestUnits, "10000");
    assert.equal(cfg.facilitatorUrl, "https://x402.org/facilitator");
    assert.equal(cfg.rpcMode, "mock");
    assert.equal(cfg.rpcUpstreamUrl, null);
    assert.equal(cfg.trustProxy, false);
  });

  it("fails when the merchant account is missing, without echoing other values", () => {
    assert.throws(() => loadConfig({}), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /HEDERA_MERCHANT_ACCOUNT_ID is required/);
      return true;
    });
  });

  it("rejects malformed Hedera account and asset ids", () => {
    assert.throws(() => loadConfig({ HEDERA_MERCHANT_ACCOUNT_ID: "abc" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, HEDERA_X402_ASSET_ID: "USDC" }), ConfigError);
  });

  it("rejects non-integer or non-positive prices (no floating point amounts)", () => {
    for (const price of ["0.0001", "1e4", "-5", "0", "abc"]) {
      assert.throws(
        () => loadConfig({ ...base, HEDERA_X402_PRICE_SMALLEST_UNITS: price }),
        ConfigError,
        `price ${price} should be rejected`,
      );
    }
  });

  it("refuses any network other than testnet in C1", () => {
    assert.throws(() => loadConfig({ ...base, HEDERA_NETWORK: "mainnet" }), /testnet/);
  });

  it("requires https for the facilitator (http only for localhost) and forbids credentials", () => {
    assert.throws(() => loadConfig({ ...base, X402_FACILITATOR_URL: "http://example.com" }), ConfigError);
    assert.throws(
      () => loadConfig({ ...base, X402_FACILITATOR_URL: "https://user:pass@example.com" }),
      ConfigError,
    );
    assert.doesNotThrow(() => loadConfig({ ...base, X402_FACILITATOR_URL: "http://localhost:9999" }));
  });

  it("requires an https upstream in upstream mode and ignores it in mock mode", () => {
    assert.throws(() => loadConfig({ ...base, RPC_MODE: "upstream" }), /RPC_UPSTREAM_URL is required/);
    assert.throws(
      () => loadConfig({ ...base, RPC_MODE: "upstream", RPC_UPSTREAM_URL: "http://rpc.example.com" }),
      ConfigError,
    );
    const cfg = loadConfig({ ...base, RPC_MODE: "upstream", RPC_UPSTREAM_URL: "https://rpc.example.com" });
    assert.equal(cfg.rpcUpstreamUrl, "https://rpc.example.com/");
    assert.equal(loadConfig({ ...base, RPC_MODE: "mock", RPC_UPSTREAM_URL: "not a url" }).rpcUpstreamUrl, null);
  });

  it("rejects unknown RPC modes and out-of-range ports", () => {
    assert.throws(() => loadConfig({ ...base, RPC_MODE: "dynamic" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, SELLER_PORT: "70000" }), ConfigError);
  });

  it("uses the platform port and requires durable storage on a dyno", () => {
    assert.equal(loadConfig({ ...base, PORT: "3456", SELLER_PORT: "4001" }).port, 3456);
    assert.throws(() => loadConfig({ ...base, DYNO: "web.1" }), /DATABASE_URL/);
    const cfg = loadConfig({ ...base, DYNO: "web.1", DATABASE_URL: "postgres://user:pass@localhost:5432/neverdown" });
    assert.equal(cfg.databaseUrl, "postgres://user:pass@localhost:5432/neverdown");
    assert.equal(cfg.trustProxy, true);
  });
});
