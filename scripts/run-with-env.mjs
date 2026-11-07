/** Load the single root .env without handing signing keys to service processes. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_KEYS = new Set([
  "HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY", "ARKIV_PRIVATE_KEY",
  "RECLAIM_PRIVATE_KEY", "ENS_OWNER_PRIVATE_KEY", "OPENAI_API_KEY",
  "ARKIV_ACCESS_KEY", "GATEWAY_INTERNAL_TOKEN",
]);

export function parseEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) continue;
    values[key] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

export function processEnv(profile, file = fileURLToPath(new URL("../.env", import.meta.url)), parent = process.env) {
  const values = parseEnv(readFileSync(file, "utf8"));
  const env = { ...parent };
  for (const key of SECRET_KEYS) delete env[key];
  for (const [key, value] of Object.entries(values)) {
    if (!SECRET_KEYS.has(key)) env[key] = value;
  }
  env.PAYMENT_WORKER_ENV_FILE = file;
  const allowed = {
    "pay-once": ["HEDERA_SPEND_KEY"],
    "hcs-smoke": ["HEDERA_OPERATOR_KEY"],
    "policy-smoke": ["HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY"],
    "arkiv-seed": ["ARKIV_PRIVATE_KEY", "ARKIV_ACCESS_KEY"],
    "ens-set-texts": ["ENS_OWNER_PRIVATE_KEY"],
    "agent": ["ARKIV_ACCESS_KEY", "GATEWAY_INTERNAL_TOKEN"],
    "web": ["GATEWAY_INTERNAL_TOKEN"],
    "gateway": ["GATEWAY_INTERNAL_TOKEN"],
  }[profile] ?? [];
  for (const key of allowed) {
    if (values[key] !== undefined) env[key] = values[key];
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profile, entry, ...args] = process.argv.slice(2);
  if (!profile || !entry) {
    console.error("Usage: node scripts/run-with-env.mjs <profile> <entry.ts> [args...]");
    process.exit(2);
  }
  try {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: process.cwd(),
      env: processEnv(profile),
      stdio: "inherit",
    });
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
