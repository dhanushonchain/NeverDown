import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processEnv } from "./run-with-env.mjs";

test("only designated commands receive signing keys from the shared env file", () => {
  const dir = mkdtempSync(join(tmpdir(), "neverdown-env-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(file, [
      "SELLER_URL=http://localhost:4001",
      "HEDERA_SPEND_KEY=spend-test-key",
      "HEDERA_OPERATOR_KEY=operator-test-key",
      "ARKIV_PRIVATE_KEY=arkiv-test-key",
      "ARKIV_ACCESS_KEY=arkiv-access-test-key",
      "ENS_OWNER_PRIVATE_KEY=ens-test-key",
      "GATEWAY_INTERNAL_TOKEN=token-test-value",
    ].join("\n"), { mode: 0o600 });
    const inherited = { PATH: "/bin", HEDERA_SPEND_KEY: "inherited-secret" };
    for (const profile of ["agent", "web", "seller", "gateway"]) {
      const env = processEnv(profile, file, inherited);
      assert.equal(env.SELLER_URL, "http://localhost:4001");
      assert.equal(env.PAYMENT_WORKER_ENV_FILE, file);
      for (const key of ["HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY", "ARKIV_PRIVATE_KEY", "ENS_OWNER_PRIVATE_KEY"]) {
        assert.equal(Object.hasOwn(env, key), false, `${profile} inherited ${key}`);
      }
    }
    assert.equal(processEnv("arkiv-seed", file, inherited).ARKIV_PRIVATE_KEY, "arkiv-test-key");
    assert.equal(processEnv("arkiv-seed", file, inherited).ARKIV_ACCESS_KEY, "arkiv-access-test-key");
    assert.equal(processEnv("agent", file, inherited).ARKIV_ACCESS_KEY, "arkiv-access-test-key");
    assert.equal(Object.hasOwn(processEnv("seller", file, inherited), "GATEWAY_INTERNAL_TOKEN"), false);
    assert.equal(processEnv("web", file, inherited).GATEWAY_INTERNAL_TOKEN, "token-test-value");
    assert.equal(processEnv("pay-once", file, inherited).HEDERA_SPEND_KEY, "spend-test-key");
    assert.equal(processEnv("ens-set-texts", file, inherited).ENS_OWNER_PRIVATE_KEY, "ens-test-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
