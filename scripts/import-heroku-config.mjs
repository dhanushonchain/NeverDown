/** Send filtered backend configuration to Heroku without logging values. */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "./run-with-env.mjs";

const app = process.argv[2] || "neverdown-backend";
const dryRun = process.argv.includes("--dry-run");
const file = new URL("../.env", import.meta.url);
if ((statSync(file).mode & 0o077) !== 0) throw new Error("root .env must be mode 0600");
const values = parseEnv(readFileSync(file, "utf8"));
const required = [
  "HEDERA_SPEND_ID", "HEDERA_SPEND_KEY", "HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY", "HEDERA_TOPIC_ID",
  "POLICY_ALLOWLIST", "POLICY_ENDPOINTS", "POLICY_SERVICES", "POLICY_MAX_PER_PAYMENT_TINYBARS", "POLICY_TOTAL_BUDGET_TINYBARS",
  "ENS_RPC_URL", "ENS_ALLOWLIST_NAMES", "SELLER_ENS_NAME", "SELLER_URL", "POC_REFERENCE_RPC",
  "ARKIV_ACCESS_KEY", "ARKIV_RPC", "ARKIV_CHAIN_ID", "GATEWAY_PRIMARY_RPC_URL", "GATEWAY_STANDBY_RPC_URL",
  "GATEWAY_INTERNAL_TOKEN", "OPENAI_API_KEY",
];
const missing = required.filter((key) => !values[key]);
if (missing.length) throw new Error(`missing backend settings: ${missing.join(", ")}`);
if (!values.GATEWAY_RPC_TOKEN && !dryRun) {
  values.GATEWAY_RPC_TOKEN = randomBytes(32).toString("hex");
  appendFileSync(file, `\nGATEWAY_RPC_TOKEN=${values.GATEWAY_RPC_TOKEN}\n`, { mode: 0o600 });
}
const allowed = (key) => /^(HEDERA_|POLICY_|HCS_|X402_|GATEWAY_)/.test(key) || [
  "SELLER_ENS_NAME", "SELLER_URL", "ENS_RPC_URL", "ENS_ALLOWLIST_NAMES", "POC_REFERENCE_RPC",
  "ARKIV_ACCESS_KEY", "ARKIV_RPC", "ARKIV_CHAIN_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL",
].includes(key);
const excluded = new Set([
  "POLICY_DB_PATH", "INCIDENT_DB_PATH", "PAYMENT_WORKER_ENV_FILE", "GATEWAY_PORT", "GATEWAY_URL",
  "GATEWAY_INTERNAL_API", "GATEWAY_RPC", "GATEWAY_STANDBY_RPC", "GATEWAY_PRIMARY_RPC", "ENS_ALLOW_TEXT_OVERLAY",
]);
const entries = Object.entries(values).filter(([key, value]) => allowed(key) && !excluded.has(key) && value);
entries.push(["GATEWAY_INTERNAL_API", "true"], ["COORDINATOR_ENABLED", "true"], ["HCS_AUDIT_AVAILABILITY", "REQUIRED_DURABLE"]);
for (const [key, value] of entries) if (/[\r\n]/.test(value)) throw new Error(`${key} contains newline`);
if (dryRun) { console.log(`Heroku config ready (${entries.length} names, values hidden).`); process.exit(0); }

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${command} failed (exit ${code}); output hidden`)));
  });
}
const token = await run("heroku", ["auth:token"]);
const response = await fetch(`https://api.heroku.com/apps/${encodeURIComponent(app)}/config-vars`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.heroku+json; version=3", "Content-Type": "application/json" },
  body: JSON.stringify(Object.fromEntries(entries)),
});
if (!response.ok) throw new Error(`Heroku config API returned ${response.status}; response body hidden`);
console.log(`Imported ${entries.length} backend config names to ${app}; values hidden.`);
