import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNeverDownHostEnv } from "../src/env.js";

describe("assertNeverDownHostEnv", () => {
  it("accepts a minimal valid host env", () => {
    const result = assertNeverDownHostEnv({
      ENS_RPC_URL: "https://ethereum-rpc.publicnode.com",
      ENS_ALLOWLIST_NAMES: "neverdownseller.eth",
    });
    assert.equal(result.allowlist.length, 1);
    assert.equal(result.hostEnv.ENS_RPC_URL, "https://ethereum-rpc.publicnode.com");
  });

  it("lists multiple problems in one error", () => {
    assert.throws(
      () => assertNeverDownHostEnv({ HEDERA_SPEND_KEY: "x" }),
      /HEDERA_SPEND_KEY[\s\S]*ENS_RPC_URL is required[\s\S]*ENS_ALLOWLIST_NAMES/,
    );
  });
});
