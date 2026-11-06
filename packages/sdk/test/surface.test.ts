import assert from "node:assert/strict";
import { it } from "node:test";

it("SDK entry exposes safe rails without buyer signing internals", async () => {
  const sdk = await import("../src/index.js");
  for (const name of ["resolveAndValidateEnsSeller", "discoverOffers", "proofOfCapability", "startPaymentWorker"]) {
    assert.equal(typeof (sdk as Record<string, unknown>)[name], "function", name);
  }
  for (const name of ["payForRpcOnce", "createHederaX402HttpClient", "loadBuyerConfig", "HederaHcsClient", "openBudgetStore", "securePurchase"]) {
    assert.equal(name in sdk, false, name);
  }
});
