import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { IncidentLedger } from "../../../packages/core/src/agent/coordinator.js";
import { getGatewayStatus } from "@neverdown/sdk/status";
import { evidenceResponse } from "./evidence.js";

const PORT = Number(process.env.WEB_PORT ?? 3000);
const GATEWAY_URL = (process.env.GATEWAY_URL?.trim() || "http://localhost:8787").replace(/\/$/, "");
const ROOT = resolve(process.cwd(), "..", "..");
const PUBLIC = join(process.cwd(), "public");
const incidentLedger = new IncidentLedger(resolve(ROOT, process.env.INCIDENT_DB_PATH?.trim() || "neverdown-incidents.sqlite"));

function send(res: ServerResponse, status: number, body: any, contentType = "application/json") {
  res.writeHead(status, { "content-type": contentType });
  if (typeof body === "string" || Buffer.isBuffer(body)) res.end(body);
  else res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({ raw: data }); }
    });
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method === "GET" && (pathname === "/api/incidents" || pathname.startsWith("/api/incidents/"))) {
    const result = evidenceResponse(pathname, incidentLedger);
    res.setHeader("Cache-Control", "no-store");
    send(res, result.status, result.body);
    return;
  }
  if (pathname === "/api/status" && req.method === "GET") {
    try {
      const { ready, status } = await getGatewayStatus(GATEWAY_URL);
      send(res, 200, { ready, status, gatewayUrl: GATEWAY_URL });
    } catch (e) {
      send(res, 502, { error: e instanceof Error ? e.message : "gateway unavailable" });
    }
    return;
  }

  if (pathname === "/api/evidence" && req.method === "GET") {
    send(res, 200, {
      ens: process.env.SELLER_ENS_NAME || "neverdownseller.eth",
      arkivEntityKey: process.env.DEMO_ARKIV_ENTITY_KEY || "0x74867aaf0276debc7b151f1a40e6c1cd4e06d14018539f01112a17738a63310d",
      transactionId: process.env.DEMO_HEDERA_TX_ID || "0.0.9185802@1793985063.486076384",
      hashscanUrl: process.env.DEMO_HASHSCAN_URL || "https://hashscan.io/testnet/transaction/0.0.9185802%401793985063.486076384",
      topicId: process.env.HEDERA_TOPIC_ID || "",
      note: "Live IDs from docs/LIVE-EVIDENCE.md — refresh after each settle",
    });
    return;
  }

  if (pathname === "/api/run-agent" && req.method === "POST") {
    const body = await readBody(req);
    const scenario = body.scenario === "deny" ? "deny" : "procure";
    const live = process.env.AGENT_LIVE === "true" || body.live === true;
    const script = [join(ROOT, "scripts/run-with-env.mjs"), "agent", "scripts/agent-demo.ts", "--scenario", scenario, ...(live ? ["--live"] : [])];
    const agent = spawn(process.execPath, script, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    agent.stdout.on("data", (c) => (out += c));
    agent.stderr.on("data", (c) => (out += c));
    agent.on("close", (code) => {
      let parsed: unknown = null;
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(out.slice(start, end + 1)); } catch { parsed = null; }
      }
      send(res, code === 0 ? 200 : 500, { scenario, mode: live ? "live" : "hermetic", exitCode: code, receipt: parsed, output: out });
    });
    return;
  }

  if (pathname === "/api/outage" && req.method === "POST") {
    const token = process.env.GATEWAY_INTERNAL_TOKEN || "";
    if (!process.env.GATEWAY_INTERNAL_API || process.env.GATEWAY_INTERNAL_API !== "true") {
      send(res, 412, { error: "Enable GATEWAY_INTERNAL_API=true and set GATEWAY_INTERNAL_TOKEN to use inject hooks." });
      return;
    }
    const body = await readBody(req);
    try {
      const r = await fetch(`${GATEWAY_URL}/_internal/install-standby`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-internal-token": token },
        body: JSON.stringify(body || {}),
      });
      send(res, r.status, await r.json().catch(() => ({})));
    } catch (e) {
      send(res, 502, { error: e instanceof Error ? e.message : "outage proxy unavailable" });
    }
    return;
  }

  send(res, 404, { error: "unknown route" });
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const path = resolve(PUBLIC, file);
  if (!path.startsWith(`${PUBLIC}${sep}`) || file.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
    send(res, 404, "not found", "text/plain");
    return;
  }
  if (existsSync(path)) {
    try {
      const body = readFileSync(path);
      send(res, 200, body, MIME[extname(path)] || "text/plain");
    } catch {
      send(res, 404, "not found", "text/plain");
    }
    return;
  }
  send(res, 404, "not found", "text/plain");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`NeverDown site listening on http://localhost:${PORT} (console: /console.html)`);
  console.log(`Gateway: ${GATEWAY_URL}`);
});
