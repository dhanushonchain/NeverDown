/** Import only the backend's required settings to Fly. Never echoes values. */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "./run-with-env.mjs";

const app = process.argv[2] || "neverdown-backend";
const dryRun = process.argv.includes("--dry-run");
const file = new URL("../.env", import.meta.url);
const mode = statSync(file).mode & 0o777;
if ((mode & 0o077) !== 0) throw new Error("root .env must be mode 0600");
const values = parseEnv(readFileSync(file, "utf8"));
const required = [
  "HEDERA_SPEND_ID", "HEDERA_SPEND_KEY", "HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY",
  "HEDERA_TOPIC_ID", "POLICY_ALLOWLIST", "POLICY_ENDPOINTS", "POLICY_SERVICES",
  "POLICY_MAX_PER_PAYMENT_TINYBARS", "POLICY_TOTAL_BUDGET_TINYBARS",
  "ENS_RPC_URL", "ENS_ALLOWLIST_NAMES", "SELLER_ENS_NAME", "SELLER_URL",
  "POC_REFERENCE_RPC", "ARKIV_ACCESS_KEY", "ARKIV_RPC", "ARKIV_CHAIN_ID",
  "GATEWAY_PRIMARY_RPC_URL", "GATEWAY_STANDBY_RPC_URL", "GATEWAY_INTERNAL_TOKEN",
  "OPENAI_API_KEY",
];
const missing = required.filter((key) => !values[key]);
if (missing.length) throw new Error(`missing required backend settings: ${missing.join(", ")}`);
if (!values.GATEWAY_RPC_TOKEN && !dryRun) {
  values.GATEWAY_RPC_TOKEN = randomBytes(32).toString("hex");
  appendFileSync(file, `\nGATEWAY_RPC_TOKEN=${values.GATEWAY_RPC_TOKEN}\n`, { mode: 0o600 });
}

const allowed = (key) =>
  /^(HEDERA_|POLICY_|HCS_|X402_|GATEWAY_)/.test(key) ||
  ["SELLER_ENS_NAME", "SELLER_URL", "ENS_RPC_URL", "ENS_ALLOWLIST_NAMES",
    "POC_REFERENCE_RPC", "ARKIV_ACCESS_KEY", "ARKIV_RPC", "ARKIV_CHAIN_ID",
    "OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key);
const excluded = new Set([
  "POLICY_DB_PATH", "INCIDENT_DB_PATH", "PAYMENT_WORKER_ENV_FILE",
  "GATEWAY_PORT", "GATEWAY_URL", "GATEWAY_INTERNAL_API",
  "GATEWAY_RPC", "GATEWAY_STANDBY_RPC", "GATEWAY_PRIMARY_RPC",
  "ENS_ALLOW_TEXT_OVERLAY",
]);
const entries = Object.entries(values).filter(([key, value]) => allowed(key) && !excluded.has(key) && value);
for (const [key, value] of entries) {
  if (/[\r\n]/.test(value)) throw new Error(`${key} contains a newline`);
}
if (dryRun) {
  console.log(`Fly backend secret names ready (${entries.length}); values hidden.`);
  process.exit(0);
}

const child = spawn("flyctl", ["secrets", "import", "--app", app], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
child.stdin.end(entries.map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) throw new Error(`Fly secret import failed (exit ${code}); check flyctl login and app access`);
console.log(`Imported ${entries.length} backend secret names to ${app}; values hidden.`);
