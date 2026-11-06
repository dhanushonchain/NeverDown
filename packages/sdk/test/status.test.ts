import assert from "node:assert/strict";
import { it } from "node:test";
import { getGatewayStatus, evidenceLinks } from "../src/status.js";

it("reads gateway readiness and status without credentials", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.headers, undefined);
    return { ok: true, json: async () => url.endsWith("/ready") ? { ready: true } : { active: "standby", providers: [{ id: "standby", healthy: true }] } };
  }) as unknown as typeof fetch;
  const snapshot = await getGatewayStatus("http://localhost:8787/", fetchImpl);
  assert.equal(snapshot.ready.ready, true);
  assert.equal(snapshot.status.active, "standby");
  assert.deepEqual(calls, ["http://localhost:8787/ready", "http://localhost:8787/status"]);
});

it("rejects unavailable status and builds testnet evidence links", async () => {
  let calls = 0;
  await assert.rejects(getGatewayStatus("http://localhost:8787", (async () => {
    calls += 1;
    return calls === 1 ? { ok: true, json: async () => ({ ready: true }) } : { ok: false, status: 503 };
  }) as unknown as typeof fetch), /503/);
  const links = evidenceLinks({ transactionId: "0.0.1@123.456", topicId: "0.0.2" });
  assert.equal(links.hashscan, "https://hashscan.io/testnet/transaction/0.0.1%40123.456");
  assert.equal(links.topic, "https://hashscan.io/testnet/topic/0.0.2");
});

it("returns degraded readiness so the console can show the outage", async () => {
  const fetchImpl = (async (url: string) => url.endsWith("/ready")
    ? { ok: false, status: 503, json: async () => ({ ready: false, active: null }) }
    : { ok: true, json: async () => ({ active: null, providers: [] }) }) as unknown as typeof fetch;
  const snapshot = await getGatewayStatus("http://localhost:8787", fetchImpl);
  assert.equal(snapshot.ready.ready, false);
});
