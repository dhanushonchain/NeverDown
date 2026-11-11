import express, { type NextFunction, type Request, type Response } from "express";
import { EntitlementStore } from "./entitlement.js";
import { PostgresEntitlementStore } from "./postgresEntitlement.js";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware } from "@x402/express";
import type { SellerConfig } from "./config.js";
import {
  forwardToUpstream,
  mockResult,
  validateJsonRpc,
  type JsonRpcRequest,
  type JsonRpcId,
} from "./rpc.js";

export interface AppOptions {
  config: SellerConfig;
  facilitatorClient?: FacilitatorClient;
  fetchImpl?: typeof fetch;
  syncFacilitatorOnStart?: boolean;
  onExecute?: (method: string) => void;
}

const RPC_BODY_LIMIT = "16kb";
const PROBE_LIMIT_PER_MINUTE = 120;
const PACK_REQUESTS = 100;
const PACK_DURATION_MS = 15 * 60_000;

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

export function createApp(opts: AppOptions): express.Express {
  const { config } = opts;
  const entitlements = config.databaseUrl
    ? new PostgresEntitlementStore(config.databaseUrl)
    : new EntitlementStore(config.entitlementDbPath);
  const facilitator = opts.facilitatorClient ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactHederaScheme(),
  );
  resourceServer.onAfterSettle(async (ctx) => {
    const transport = ctx.transportContext as { request?: { method?: string; path?: string }; responseBody?: Buffer } | undefined;
    if (transport?.request?.method !== "POST" || transport.request.path !== "/rpc-pack") return;
    const body = transport?.responseBody;
    if (!body) throw new Error("missing pack response");
    const token = (JSON.parse(body.toString("utf8")) as { token?: unknown }).token;
    if (typeof token !== "string") throw new Error("missing pack token");
    await entitlements.activate(token);
  });

  const routes = {
    "POST /rpc": {
      accepts: [
        {
          scheme: "exact",
          network: config.network,
          payTo: config.merchantAccountId,
          price: { asset: config.assetId, amount: config.priceSmallestUnits },
          maxTimeoutSeconds: 60,
        },
      ],
      description: "Paid JSON-RPC access to a NeverDown RPC endpoint",
      mimeType: "application/json",
    },
    "POST /rpc-pack": {
      accepts: [{
        scheme: "exact",
        network: config.network,
        payTo: config.merchantAccountId,
        price: { asset: config.assetId, amount: config.priceSmallestUnits },
        maxTimeoutSeconds: 60,
      }],
      description: "Bounded NeverDown RPC standby entitlement",
      mimeType: "application/json",
    },
  };

  const app = express();
  app.disable("x-powered-by");
  // Heroku terminates HTTPS at its router; x402 derives the resource URL from req.protocol.
  if (config.trustProxy) app.set("trust proxy", 1);
  let probeWindowStart = Date.now();
  let probeCount = 0;

  app.get("/health", async (_req: Request, res: Response) => {
    if (!await entitlements.health()) {
      res.status(503).json({ status: "unavailable", service: "neverdown-rpc-seller" });
      return;
    }
    res.json({ status: "ok", service: "neverdown-rpc-seller", network: config.network });
  });

  // Public proof is deliberately narrow and capped per seller process. It cannot
  // be used as an unrestricted unpaid JSON-RPC proxy.
  app.post("/probe", express.json({ limit: RPC_BODY_LIMIT }), async (req: Request, res: Response) => {
    const result = validateJsonRpc(req.body);
    if (!result.ok) {
      res.status(400).json(rpcError(result.id, result.error.code, result.error.message));
      return;
    }
    const rpc = result.request;
    if (rpc.method === "net_version") {
      res.status(400).json(rpcError(rpc.id, -32601, "Method not allowed for probe"));
      return;
    }
    const now = Date.now();
    if (now - probeWindowStart >= 60_000) { probeWindowStart = now; probeCount = 0; }
    if (++probeCount > PROBE_LIMIT_PER_MINUTE) {
      res.status(429).json(rpcError(rpc.id, -32005, "Probe rate limit exceeded"));
      return;
    }
    if (config.rpcMode === "mock") {
      res.json({ jsonrpc: "2.0", id: rpc.id, result: mockResult(rpc.method) });
      return;
    }
    const outcome = await forwardToUpstream(config.rpcUpstreamUrl!, rpc, opts.fetchImpl);
    if (!outcome.ok) {
      res.status(502).json(rpcError(rpc.id, outcome.error.code, outcome.error.message));
      return;
    }
    res.json({ jsonrpc: "2.0", id: rpc.id, result: outcome.result });
  });

  app.post("/rpc-pack", express.json({ limit: "1kb" }), paymentMiddleware(routes, resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true), async (_req: Request, res: Response) => {
    const token = await entitlements.issuePending(PACK_REQUESTS, PACK_DURATION_MS);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ token, expiresInSeconds: PACK_DURATION_MS / 1000, maxRequests: PACK_REQUESTS });
  });

  async function executeRpc(res: Response): Promise<void> {
    const rpc = res.locals.rpc as JsonRpcRequest;
    opts.onExecute?.(rpc.method);
    if (config.rpcMode === "mock") {
      res.json({ jsonrpc: "2.0", id: rpc.id, result: mockResult(rpc.method) });
      return;
    }
    const outcome = await forwardToUpstream(config.rpcUpstreamUrl!, rpc, opts.fetchImpl);
    if (!outcome.ok) {
      res.status(502).json(rpcError(rpc.id, outcome.error.code, outcome.error.message));
      return;
    }
    res.json({ jsonrpc: "2.0", id: rpc.id, result: outcome.result });
  }

  // Body parsing and JSON-RPC shape checks run before payment, so malformed or
  // disallowed requests are rejected without a 402 challenge and never reach upstream.
  app.post(
    "/rpc",
    express.json({ limit: RPC_BODY_LIMIT }),
    (req: Request, res: Response, next: NextFunction) => {
      const result = validateJsonRpc(req.body);
      if (!result.ok) {
        res.status(400).json(rpcError(result.id, result.error.code, result.error.message));
        return;
      }
      res.locals.rpc = result.request;
      next();
    },
    async (req: Request, res: Response, next: NextFunction) => {
      const authorization = req.header("authorization");
      if (!authorization) { next(); return; }
      const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
      if (!match || !await entitlements.consume(match[1]!)) {
        res.status(401).json(rpcError((res.locals.rpc as JsonRpcRequest).id, -32001, "Invalid or exhausted entitlement"));
        return;
      }
      void executeRpc(res).catch(next);
    },
    paymentMiddleware(routes, resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true),
    (_req: Request, res: Response, next: NextFunction) => { void executeRpc(res).catch(next); },
  );

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      res.status(400).json(rpcError(null, -32700, "Parse error"));
      return;
    }
    if (err.type === "entity.too.large") {
      res.status(413).json(rpcError(null, -32600, "Request body too large"));
      return;
    }
    console.error("unhandled error:", err.name);
    res.status(500).json(rpcError(null, -32603, "Internal error"));
  });

  return app;
}
