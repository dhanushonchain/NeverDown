/** Merge legacy local profiles into one ignored, owner-readable root .env. */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./run-with-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [".env", ".env.seller", ".env.agent", ".env.worker", ".env.arkiv-seed"];
const values = {};
const present = [];

for (const name of files) {
  const path = `${root}${name}`;
  if (!existsSync(path)) continue;
  present.push(name);
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value || !(key in values)) values[key] = value;
  }
}

if (!present.length) {
  console.error("No .env found. Copy .env.example to .env, then fill in local values.");
  process.exit(1);
}

if (!values.GATEWAY_INTERNAL_TOKEN) values.GATEWAY_INTERNAL_TOKEN = randomBytes(24).toString("hex");
values.PAYMENT_WORKER_ENV_FILE = `${root}.env`;

const body = [
  "# NeverDown local configuration. Keep this file private and out of Git.",
  "# Services load only their required keys; the payment worker reads this file directly.",
  ...Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`),
  "",
].join("\n");
const temp = `${root}.env.tmp-${process.pid}`;
writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
chmodSync(temp, 0o600);
renameSync(temp, `${root}.env`);
for (const name of present) {
  if (name !== ".env") rmSync(`${root}${name}`);
}
console.log(`Consolidated ${present.join(", ")} into .env (mode 0600).`);
