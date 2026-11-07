/** Gateway and incident coordinator in one persistent Node process. */
import { createServer } from "node:http";
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createGatewayApp } from "../apps/gateway/src/app.js";
import { loadGatewayConfig } from "../apps/gateway/src/config.js";
import { IncidentCoordinator, IncidentLedger, type GatewayIncidentSnapshot } from "../packages/core/src/agent/coordinator.js";
import { createLiveToolBelt, runAgentScenario } from "../packages/core/src/agent/index.js";

const signingKeys = ["HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY"];
const forbiddenParentKeys = [...signingKeys, "ARKIV_PRIVATE_KEY", "RECLAIM_PRIVATE_KEY", "ENS_OWNER_PRIVATE_KEY"];

function prepareWorkerFile(): void {
  const dataDir = process.env.NEVERDOWN_DATA_DIR?.trim();
  if (dataDir) {
    if (!isAbsolute(dataDir)) throw new Error("NEVERDOWN_DATA_DIR must be absolute");
    process.env.POLICY_DB_PATH = join(dataDir, "neverdown-policy.sqlite");
    process.env.INCIDENT_DB_PATH = join(dataDir, "neverdown-incidents.sqlite");
    process.env.PAYMENT_WORKER_ENV_FILE = join(dataDir, "worker.env");
  }
  const file = process.env.PAYMENT_WORKER_ENV_FILE?.trim();
  if (!file) throw new Error("PAYMENT_WORKER_ENV_FILE is required");
  if (dataDir && signingKeys.some((key) => !process.env[key])) throw new Error("hosted signing credentials are required on every start");
  if (signingKeys.some((key) => process.env[key])) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(HEDERA_|POLICY_|HCS_|X402_)/.test(key) && key !== "SELLER_URL" && key !== "ENS_ALLOWLIST_NAMES") continue;
      if (value === undefined) continue;
      if (/[\r\n]/.test(value)) throw new Error(`${key} contains a newline`);
      lines.push(`${key}=${value}`);
    }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  }
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error("worker env file must be mode 0600");
  for (const key of forbiddenParentKeys) delete process.env[key];
}

async function main(): Promise<void> {
  prepareWorkerFile();
  const port = Number(process.env.PORT || process.env.GATEWAY_PORT || 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");
  if ((process.env.GATEWAY_RPC_TOKEN?.length ?? 0) < 20) throw new Error("GATEWAY_RPC_TOKEN of at least 20 characters is required for hosted access");
  if (process.env.GATEWAY_INTERNAL_API !== "true" || (process.env.GATEWAY_INTERNAL_TOKEN?.length ?? 0) < 20) {
    throw new Error("authenticated gateway install API is required for hosted procurement");
  }
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const config = loadGatewayConfig({ ...process.env, GATEWAY_PORT: String(port) });
  const { app, controller } = createGatewayApp({ config });
  const incidentPath = resolve(process.env.INCIDENT_DB_PATH?.trim() || "neverdown-incidents.sqlite");
  mkdirSync(dirname(incidentPath), { recursive: true });
  const ledger = new IncidentLedger(incidentPath);
  const tools = createLiveToolBelt({ ...process.env, GATEWAY_URL: gatewayUrl });
  const coordinator = new IncidentCoordinator(
    ledger,
    async (): Promise<GatewayIncidentSnapshot> => {
      const response = await fetch(`${gatewayUrl}/status`, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error("gateway status unavailable");
      return await response.json() as GatewayIncidentSnapshot;
    },
    async (incidentId) => {
      const receipt = await runAgentScenario("procure", tools);
      console.log(`incident ${incidentId}: ${receipt.success ? "completed" : "stopped"}`);
      return receipt;
    },
  );
  const server = createServer(app);
  server.listen(port, "0.0.0.0", () => {
    console.log(`neverdown backend listening on :${port}`);
    controller.start();
  });
  const enabled = process.env.COORDINATOR_ENABLED === "true";
  const tick = () => { void coordinator.poll().catch((error: unknown) =>
    console.error("coordinator poll failed:", error instanceof Error ? error.name : "unknown")); };
  if (enabled) tick();
  const timer = enabled ? setInterval(tick, 2_000) : undefined;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    controller.stop();
    server.close(() => { ledger.close(); process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "backend startup failed");
  process.exitCode = 1;
});
