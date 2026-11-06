import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNeverDownClient, NeverDown } from "../src/client.js";

const env = {
  ENS_RPC_URL: "https://ethereum.example/rpc",
  ENS_ALLOWLIST_NAMES: "seller.eth",
  POC_REFERENCE_RPC: "https://reference.example/rpc",
  ARKIV_ACCESS_KEY: "read-key",
};

describe("NeverDown read-only client", () => {
  it("fails closed on missing allowlist and parent spend keys", () => {
    assert.throws(() => NeverDown.create({ env: { ENS_RPC_URL: env.ENS_RPC_URL } }), /ENS_ALLOWLIST_NAMES/);
    assert.throws(() => NeverDown.create({ env: { ...env, HEDERA_SPEND_KEY: "secret" } }), /HEDERA_SPEND_KEY/);
  });

  it("uses the configured ENS RPC and filters discovered offers by name", async () => {
    const calls: unknown[][] = [];
    const client = createNeverDownClient({ env }, {
      resolve: async (...args) => { calls.push(args); return { ensName: "seller.eth", normalizedEnsName: "seller.eth", address: null, resolverAddress: null, records: { hederaAccount: "0.0.123", x402Url: "https://seller.example" } }; },
      discover: async () => [
        { sellerens: "old.eth", pricetinybars: 1n },
        { sellerens: "seller.eth", pricetinybars: 2n },
      ] as never,
      prove: async () => ({ pass: true, checks: [] }),
    });
    const seller = await client.resolveSeller({ ensName: "seller.eth", expectedPayTo: "0.0.123" });
    assert.equal(seller.records.hederaAccount, "0.0.123");
    assert.deepEqual(calls[0], ["seller.eth", "0.0.123", env.ENS_RPC_URL, ["seller.eth"]]);
    const offers = await client.discoverOffers({ category: "rpc", maxPriceTinybars: 10000n });
    assert.deepEqual(offers.map((offer) => offer.sellerens), ["seller.eth"]);
  });

  it("requires an independent reference for capability proof", async () => {
    const client = createNeverDownClient({ env: { ...env, POC_REFERENCE_RPC: "" } }, {
      resolve: async () => { throw new Error("unused"); },
      discover: async () => [],
      prove: async () => { throw new Error("must not call"); },
    });
    await assert.rejects(client.proveCapability({ rpcUrl: "https://seller.example/probe", expectedChainId: 11155111, payTo: "0.0.123", ensPayTo: "0.0.123" }), /POC_REFERENCE_RPC/);
  });

  it("bounds network calls made by the default capability proof", async () => {
    let sawFetch = false;
    const client = createNeverDownClient({ env }, {
      resolve: async () => { throw new Error("unused"); },
      discover: async () => [],
      prove: async (input) => { sawFetch = typeof input.fetchImpl === "function"; return { pass: true, checks: [] }; },
    });
    await client.proveCapability({ rpcUrl: "https://seller.example/probe", expectedChainId: 11155111, payTo: "0.0.123", ensPayTo: "0.0.123" });
    assert.equal(sawFetch, true);
  });
});
