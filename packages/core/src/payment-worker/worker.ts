import { runPurchase } from "./purchase.js";
import { readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { buildPurchaseDeps, loadCredentials } from "./purchase.js";
import { parseWorkerRequestMessage, parseHelloMessage, PaymentWorkerError, isRecord } from "./protocol.js";

async function recover(store: any) {
  try { await store.recoverAfterRestart?.(); } catch {}
}

export function createWorkerServer(deps: any, send: (msg: any) => void) {
  let token: string | undefined = process.env.PAYMENT_WORKER_TOKEN;
  const queue: any[] = [];
  let running = false;
  const matches = (expected: string, supplied: string) => expected === supplied && expected.length > 0;

  async function runOne(reqMsg: any) {
    running = true;
    try {
      const outcome = await runPurchase(process.env, deps, loadedCredentials, reqMsg.request);
      const serial = JSON.parse(JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as any;
      send({ type: "result", requestId: reqMsg.requestId, outcome: serial });
    } catch (e) {
      send({ type: "error", requestId: reqMsg.requestId, code: "WORKER_ERROR", message: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
      const next = queue.shift();
      if (next) runOne(next);
    }
  }

  function handleMessage(raw: any) {
    // first allow hello without token
    if (isRecord(raw) && raw.type === "hello") {
      try {
        const t = parseHelloMessage(raw);
        if (!token) { token = t; send({ type: "ready" }); return; }
        if (t !== token) throw new PaymentWorkerError("invalid token", "UNAUTHORIZED");
        send({ type: "ready" });
        return;
      } catch (e) {
        send({ type: "error", requestId: "?", code: "BAD_HELLO", message: e instanceof Error ? e.message : "bad hello" });
        return;
      }
    }
    if (!token) {
      send({ type: "error", requestId: isRecord(raw)&&typeof raw.requestId==="string"?raw.requestId:"?", code: "UNAUTHORIZED", message: "no session established" });
      return;
    }
    let parsed: { requestId: string; token: string; request: any };
    try { parsed = parseWorkerRequestMessage(raw); } catch (e) {
      send({ type: "error", requestId: isRecord(raw)&&typeof raw.requestId==="string"?raw.requestId:"?", code: e instanceof Error && "code" in e ? (e as any).code : "INVALID_REQUEST", message: e instanceof Error ? e.message : "invalid request" });
      return;
    }
    if (!matches(token, parsed.token)) {
      send({ type: "error", requestId: parsed.requestId, code: "UNAUTHORIZED", message: "invalid caller token" });
      return;
    }
    if (running) { queue.push(parsed); } else { runOne(parsed); }
  }

  return { handleMessage };
}

let loadedCredentials: any;
export async function startWorker() {
  const envFile = process.env.PAYMENT_WORKER_ENV_FILE;
  if (envFile) {
    try {
      const raw = readFileSync(envFile, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx+1).trim().replace(/^["']|["']$/g, "");
        if (key) process.env[key] = value;
      }
    } catch {}
    try {
      // POSIX mode bits are not meaningful on Windows NTFS the same way; enforce 0600 on unix only.
      if (platform() !== "win32") {
        const st = statSync(envFile);
        if ((st.mode & 0o077) !== 0) {
          if (process.send) process.send({ type: "error", requestId: "?", code: "UNSAFE_ENV_FILE", message: "worker credential file must be mode 0600" });
          process.exit(1);
        }
      }
    } catch {}
  }
  const deps = buildPurchaseDeps(process.env);
  loadedCredentials = loadCredentials(process.env);
  await deps.store.initializePolicy(deps.policy.policyId, 0n);
  await recover(deps.store);
  const server: any = createWorkerServer(deps, (msg) => {
    if (process.send) process.send(msg);
  });
  process.on("message", (m) => server.handleMessage(m));
  process.on("disconnect", () => process.exit(0));
  return deps;
}

if (process.send) void startWorker().catch(() => process.exit(1));
