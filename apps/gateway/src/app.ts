import express, { type Request, type Response, type NextFunction } from "express";
import { GatewayController } from "./gateway.js";
import type { GatewayConfig } from "./config.js";

export interface AppOptions {
  config: GatewayConfig;
  controller?: GatewayController;
}

const RPC_BODY_LIMIT = "16kb";
const readMethods = ["eth_chainId", "eth_blockNumber", "net_version"];

import type { Application } from "express";
export function createGatewayApp(opts: AppOptions): { app: Application; controller: GatewayController } {
  const config = opts.config;
  const controller = opts.controller ?? new GatewayController(config);

  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "neverdown-rpc-gateway", uptimeMs: controller.uptimeMs() });
  });

  app.get("/ready", (_req: Request, res: Response) => {
    const ready = config.providers.some((p) => controller.getStatus(p.id)?.healthy);
    res.status(ready ? 200 : 503).json({ ready, active: controller.activeProvider(), providers: config.providers.length });
  });

  app.get("/status", (_req: Request, res: Response) => {
    res.json(controller.snapshot());
  });

  app.post("/rpc", express.json({ limit: RPC_BODY_LIMIT }), async (req: Request, res: Response) => {
    if (config.rpcToken && req.headers["x-gateway-rpc-token"] !== config.rpcToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body;

    if (Array.isArray(body) || typeof body !== "object" || body === null) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: batch requests are not supported" } });
      return;
    }
    const payload = body as Record<string, unknown>;
    if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string" || !("id" in payload)) {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    if (!readMethods.includes(payload.method)) {
      res.status(400).json({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32601, message: "Method not found or not allowed" } });
      return;
    }
    if (payload.params !== undefined && !Array.isArray(payload.params)) {
      res.status(400).json({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32602, message: "Invalid params" } });
      return;
    }

    const result = await controller.forwardJsonRpc(payload);
    res.status(result.status).json(result.json);
  });

  // Internal control hook, disabled by default. Authenticated only if token is set.
  const authorizeInstallApi = (req: Request, res: Response): boolean => {
    if (!config.internalApiEnabled) {
      res.status(404).json({ error: "not available" });
      return false;
    }
    const token = (req.headers["x-gateway-internal-token"] ?? "") as string;
    if (!config.internalToken || token !== config.internalToken) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  app.get("/_internal/ready", (req: Request, res: Response) => {
    if (!authorizeInstallApi(req, res)) return;
    res.json({ ready: true });
  });

  app.post("/_internal/install-standby", express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
    if (!authorizeInstallApi(req, res)) return;
    const result = await controller.installStandby(req.body);
    res.status(result.status).json(result.body);
  });

  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (err.type === "entity.too.large") {
      res.status(413).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } });
      return;
    }
    console.error("gateway error:", err.name);
    res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
  });

  return { app, controller };
}

export { GatewayController } from "./gateway.js";
export type { GatewayEvent, ProviderStatus, RoutingMode } from "./gateway.js";
