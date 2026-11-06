import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parsePurchaseRequest } from "./protocol.js";
import type { PurchaseRequest } from "./protocol.js";

export type { PurchaseRequest } from "./protocol.js";

export type PaymentWorkerHandle = {
  requestPurchase(request: PurchaseRequest): Promise<any>;
  close(): void;
};

const PARENT_FORBIDDEN_KEYS = ["HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY", "ARKIV_PRIVATE_KEY", "RECLAIM_PRIVATE_KEY"];

function requireParentClean() {
  for (const key of PARENT_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      throw new Error(`parent process must not hold ${key}; move it to a worker-controlled secret source`);
    }
  }
}

function buildWorkerEnv(envFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // minimal: no secrets
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  env.NEVERDOWN_PAYMENT_WORKER = "1";
  env.PAYMENT_WORKER_ENV_FILE = envFile;
  return env;
}

export function workerLaunchSpec(clientModuleUrl: string = import.meta.url): { entryPath: string; execArgv: string[] } {
  const source = new URL(clientModuleUrl).pathname.endsWith(".ts");
  return {
    entryPath: fileURLToPath(new URL(source ? "worker.ts" : "worker.js", clientModuleUrl)),
    execArgv: source ? ["--import", "tsx"] : [],
  };
}

export function startPaymentWorker(options: { envFile: string; timeoutMs?: number }): PaymentWorkerHandle {
  requireParentClean();
  const launch = workerLaunchSpec();
  const child = fork(launch.entryPath, [], {
    env: buildWorkerEnv(options.envFile),
    execArgv: launch.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const token = randomBytes(32).toString("hex");
  let ready = false;
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const timeoutMs = options.timeoutMs ?? 15000;

  child.on("message", (msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") { ready = true; return; }
    if (msg.type === "result") {
      const p = pending.get(msg.requestId);
      if (p) { pending.delete(msg.requestId); p.resolve(msg.outcome); }
      return;
    }
    if (msg.type === "error") {
      const p = pending.get(msg.requestId);
      if (p) { pending.delete(msg.requestId); p.reject(new Error(`${msg.code}: ${msg.message}`)); }
      return;
    }
  });
  child.on("exit", () => {
    for (const p of pending.values()) p.reject(new Error("worker exited"));
    pending.clear();
  });
  child.on("error", (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  return {
    async requestPurchase(request: PurchaseRequest) {
      // validate locally too
      parsePurchaseRequest(request);
      if (!ready && !(await handshake())) {
        throw new Error("worker failed to start");
      }
      const reqId = `req-${randomBytes(8).toString("hex")}`;
      return await new Promise<any>((resolve, reject) => {
        const to = setTimeout(() => { pending.delete(reqId); reject(new Error("worker request timeout")); }, timeoutMs);
        pending.set(reqId, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
        child.send({ type: "purchase", requestId: reqId, token, request });
      });
    },
    close() {
      try { child.disconnect(); } catch {}
      try { child.kill(); } catch {}
    },
  };

  async function handshake() {
    // token round-trip as hello
    child.send({ type: "hello", token });
    return new Promise<boolean>((resolveHandshake) => {
      const to = setTimeout(() => resolveHandshake(false), timeoutMs);
      const onMsg = (msg: any) => {
        if (msg?.type === "ready") { clearTimeout(to); resolveHandshake(true); }
      };
      child.on("message", onMsg);
    });
  }
}
