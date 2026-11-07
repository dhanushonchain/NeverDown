import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { PostgresBudgetStore } from "../src/policy/postgresBudgetStore.js";
import { PostgresIncidentLedger } from "../src/agent/postgresIncidentLedger.js";

const databaseUrl = process.env.NEVERDOWN_TEST_DATABASE_URL;

test("Postgres ledgers persist and budget reservations serialize", { skip: !databaseUrl }, async () => {
  const policyId = `test-${randomUUID()}`;
  const purchaseA = `purchase-${randomUUID()}`;
  const purchaseB = `purchase-${randomUUID()}`;
  const incidentId = `incident-${randomUUID()}`;
  const a = new PostgresBudgetStore(databaseUrl!);
  const b = new PostgresBudgetStore(databaseUrl!);
  const incidents = new PostgresIncidentLedger(databaseUrl!);
  try {
    await a.initializePolicy(policyId);
    const results = await Promise.allSettled([
      a.reserveAtomic(purchaseA, policyId, "0.0.1", 7000n, 10000n, 10000n),
      b.reserveAtomic(purchaseB, policyId, "0.0.1", 7000n, 10000n, 10000n),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await a.totalCommittedOrReserved(policyId), 7000n);
    const purchased = (await a.get(purchaseA)) ? purchaseA : purchaseB;
    assert.equal((await b.get(purchased))?.state, "RESERVED");
    await a.saveAuthorization({ purchaseId: purchased, policyId, sellerPayTo: "0.0.1", amountTinybars: "7000", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await a.consumeForSigning(purchased, policyId, "0.0.1", 7000n, new Date(Date.now() + 60_000).toISOString());
    assert.equal(await b.markSettled(purchased, "test-tx"), true);
    assert.equal((await b.get(purchased))?.state, "SETTLED");
    assert.equal(await incidents.claim(incidentId, "event-1"), true);
    await incidents.finish(incidentId, "COMPLETED", { success: true, entitlementToken: "secret" });
    const reopened = new PostgresIncidentLedger(databaseUrl!);
    try {
      assert.equal(await reopened.claim(incidentId, "event-1"), false);
      assert.equal((await reopened.get(incidentId))?.status, "COMPLETED");
      assert.equal(JSON.stringify(await reopened.get(incidentId)).includes("secret"), false);
    } finally { await reopened.close(); }
  } finally { await Promise.all([a.close(), b.close(), incidents.close()]); }
});
