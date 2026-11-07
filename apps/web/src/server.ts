import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { IncidentLedger } from "../../../packages/core/src/agent/coordinator.js";
import { evidenceResponse } from "./evidence.js";

const PORT = Number(process.env.WEB_PORT ?? 3000);
const GATEWAY_URL = (process.env.GATEWAY_URL?.trim() || "http://localhost:8787").replace(/\/$/, "");
const ROOT = resolve(process.cwd(), "..", "..");
const PUBLIC = join(process.cwd(), "public");
const incidentLedger = new IncidentLedger(resolve(ROOT, process.env.INCIDENT_DB_PATH?.trim() || "neverdown-incidents.sqlite"));

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json") {
  res.writeHead(status, { "content-type": contentType, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  if (typeof body === "string" || Buffer.isBuffer(body)) res.end(body);
  else res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 16 * 1024;
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        data = "";
        return;
      }
      if (!tooLarge) data += part.toString("utf8");
    });
    req.on("end", () => {
      if (tooLarge) {
        rejectBody(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        return;
      }
      if (!data) { resolveBody({}); return; }
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          rejectBody(Object.assign(new Error("request body must be a JSON object"), { statusCode: 400 }));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        rejectBody(Object.assign(new Error("invalid JSON request body"), { statusCode: 400 }));
      }
    });
    req.on("error", rejectBody);
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

async function fetchGateway(path: string) {
  const r = await fetch(`${GATEWAY_URL}${path}`);
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: json };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method === "GET" && (pathname === "/api/incidents" || pathname.startsWith("/api/incidents/"))) {
    const result = evidenceResponse(pathname, incidentLedger);
    res.setHeader("Cache-Control", "no-store");
    send(res, result.status, result.body);
    return;
  }
  if (pathname === "/api/status" && req.method === "GET") {
    try {
      const [ready, status] = await Promise.all([fetchGateway("/ready"), fetchGateway("/status")]);
      send(res, 200, { ready: ready.body, status: status.body, gatewayUrl: GATEWAY_URL });
    } catch (e) {
      send(res, 502, { error: e instanceof Error ? e.message : "gateway unavailable" });
    }
    return;
  }

  if (pathname === "/api/evidence" && req.method === "GET") {
    send(res, 200, {
      ens: process.env.SELLER_ENS_NAME?.trim() || null,
      arkivEntityKey: process.env.DEMO_ARKIV_ENTITY_KEY?.trim() || null,
      transactionId: process.env.DEMO_HEDERA_TX_ID?.trim() || null,
      hashscanUrl: process.env.DEMO_HASHSCAN_URL?.trim() || null,
      topicId: process.env.HEDERA_TOPIC_ID?.trim() || null,
      note: "Only explicitly configured evidence references are returned. Confirm each identifier against the linked provider before treating it as current.",
    });
    return;
  }

  if (pathname === "/api/run-agent" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await readBody(req); }
    catch (error) {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : 400;
      if (!res.destroyed) send(res, status, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
    const scenario = body.scenario === "deny" ? "deny" : body.scenario === "procure" || body.scenario === undefined ? "procure" : null;
    if (!scenario) { send(res, 400, { error: "scenario must be 'procure' or 'deny'" }); return; }
    const live = process.env.AGENT_LIVE === "true";
    const script = live
      ? [join(ROOT, "scripts/run-with-env.mjs"), "agent", "scripts/agent-demo.ts", "--scenario", scenario, "--live"]
      : ["--import", "tsx", join(ROOT, "scripts/agent-demo.ts"), "--scenario", scenario];
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
    let body: Record<string, unknown>;
    try { body = await readBody(req); }
    catch (error) {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : 400;
      if (!res.destroyed) send(res, status, { error: error instanceof Error ? error.message : "invalid request body" });
      return;
    }
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
