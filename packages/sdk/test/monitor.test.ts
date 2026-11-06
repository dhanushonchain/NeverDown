import assert from "node:assert/strict";
import { it } from "node:test";
import { FailureSpotMonitor } from "../src/monitor.js";

it("detects repeated probe failures and emits one incident until recovery", async () => {
  let healthy = false;
  const incidents: string[] = [];
  const monitor = new FailureSpotMonitor();
  monitor.register({ id: "price-api", probe: async () => healthy, failureThreshold: 2, onIncident: async (event) => { incidents.push(event.reason); } });
  await monitor.checkNow("price-api");
  assert.equal(incidents.length, 0);
  await monitor.checkNow("price-api");
  await monitor.checkNow("price-api");
  assert.deepEqual(incidents, ["probe failed"]);
  healthy = true;
  await monitor.checkNow("price-api");
  healthy = false;
  await monitor.checkNow("price-api");
  await monitor.checkNow("price-api");
  assert.deepEqual(incidents, ["probe failed", "probe failed"]);
});

it("accepts explicit dApp errors and keeps the incident when its callback fails", async () => {
  let calls = 0;
  const monitor = new FailureSpotMonitor();
  monitor.register({ id: "indexer", failureThreshold: 1, onIncident: async () => { calls++; throw new Error("backup unavailable"); } });
  await assert.rejects(monitor.reportFailure("indexer", "invalid indexed data"), /backup unavailable/);
  await monitor.reportFailure("indexer", "same outage");
  assert.equal(calls, 1);
  assert.equal(monitor.status("indexer").incidentActive, true);
  monitor.reportHealthy("indexer");
  await assert.rejects(monitor.reportFailure("indexer", "new outage"), /backup unavailable/);
  assert.equal(calls, 2);
});

it("polls registered probes and reports callback failures to the app", async () => {
  const errors: string[] = [];
  const monitor = new FailureSpotMonitor();
  monitor.register({ id: "rpc", probe: () => false, onIncident: () => { throw new Error("backup failed"); }, onError: (error) => errors.push(error.message) });
  monitor.start(100);
  try {
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.deepEqual(errors, ["backup failed"]);
  } finally { monitor.stop(); }
});
