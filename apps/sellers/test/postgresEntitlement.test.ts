import assert from "node:assert/strict";
import { it } from "node:test";
import { PostgresEntitlementStore } from "../src/postgresEntitlement.js";

it("persists a paid entitlement across store instances and consumes it atomically", async (t) => {
  const url = process.env.TEST_POSTGRES_URL;
  if (!url) { t.skip("set TEST_POSTGRES_URL to run the PostgreSQL integration test"); return; }
  const first = new PostgresEntitlementStore(url, { ssl: false });
  const second = new PostgresEntitlementStore(url, { ssl: false });
  try {
    const token = await first.issuePending(2, 60_000);
    assert.equal(await second.consume(token), false);
    await first.activate(token);
    const attempts = await Promise.all([first.consume(token), second.consume(token), first.consume(token)]);
    assert.equal(attempts.filter(Boolean).length, 2);
    assert.equal(await second.consume(token), false);
  } finally {
    await first.close();
    await second.close();
  }
});
