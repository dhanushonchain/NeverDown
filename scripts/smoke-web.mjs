import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Script } from "node:vm";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const port = 3100 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: new URL("../apps/web/", import.meta.url),
  env: { ...process.env, WEB_PORT: String(port), INCIDENT_DB_PATH: `neverdown-smoke-${process.pid}.sqlite`, SELLER_ENS_NAME: "", DEMO_ARKIV_ENTITY_KEY: "", DEMO_HEDERA_TX_ID: "", DEMO_HASHSCAN_URL: "", HEDERA_TOPIC_ID: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });
async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Web server exited early: ${output}`);
    try { return await fetch(`http://127.0.0.1:${port}/`); } catch { await delay(150); }
  }
  throw new Error(`Web server did not start: ${output}`);
}
try {
  const home = await waitForServer();
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Your infrastructure should/);
  assert.match(homeHtml, /Fast Recovery Plane/);
  assert.match(homeHtml, /Procurement Plane/);
  assert.match(homeHtml, /Arkiv/);
  assert.match(homeHtml, /ENSv2/);
  assert.match(homeHtml, /Hedera x402/);
  const inlineScripts = [...homeHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(inlineScripts.length, 1);
  new Script(inlineScripts[0][1], { filename: "homepage.inline.js" });
  const ids = new Set([...homeHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, target] of homeHtml.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `missing anchor target #${target}`);
  assert.match(homeHtml, /prefers-reduced-motion/);
  assert.match(homeHtml, /aria-expanded="false"/);
  const consolePage = await fetch(`http://127.0.0.1:${port}/console.html`);
  assert.equal(consolePage.status, 200);
  const consoleHtml = await consolePage.text();
  assert.match(consoleHtml, /Supreme Agent/);
  assert.match(consoleHtml, /Resilience, under your control/);
  assert.match(consoleHtml, /--nd-accent:#187a55/);
  assert.match(homeHtml, /--nd-accent:#187a55/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/light-nd.png`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/incidents`)).status, 200);
  const evidenceRes = await fetch(`http://127.0.0.1:${port}/api/evidence`);
  assert.equal(evidenceRes.status, 200);
  const evidence = await evidenceRes.json();
  assert.equal(evidence.transactionId, null);
  assert.equal(evidence.arkivEntityKey, null);
  const disabledHook = await fetch(`http://127.0.0.1:${port}/api/outage`, { method:"POST", headers:{"content-type":"application/json"}, body:"{}" });
  assert.equal(disabledHook.status, 412);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/run-agent`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scenario:"invalid"})});
  assert.equal(invalid.status, 400);
  const hermeticAgent = await fetch(`http://127.0.0.1:${port}/api/run-agent`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scenario:"deny"})});
  assert.equal(hermeticAgent.status, 200);
  const hermeticResult = await hermeticAgent.json();
  assert.equal(hermeticResult.mode, "hermetic");
  assert.equal(hermeticResult.receipt?.success, true);
  const malformed = await fetch(`http://127.0.0.1:${port}/api/run-agent`, {method:"POST",headers:{"content-type":"application/json"},body:"{"});
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`http://127.0.0.1:${port}/api/run-agent`, {method:"POST",headers:{"content-type":"application/json"},body:"x".repeat(17 * 1024)});
  assert.equal(oversized.status, 413);
  console.log("Web smoke checks passed.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]);
  const dbPath = fileURLToPath(new URL(`../neverdown-smoke-${process.pid}.sqlite`, import.meta.url));
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}