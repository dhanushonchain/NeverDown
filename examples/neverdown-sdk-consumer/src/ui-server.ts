/**
 * Visible demo UI for the separate SDK consumer.
 * Streams each step so judges can see work happening.
 * Server-side only: NeverDown SDK never runs in the browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { NeverDown, FailureSpotMonitor } from "@neverdown/sdk";
import { getGatewayStatus, evidenceLinks } from "@neverdown/sdk/status";
import type { CapabilityOfferRow } from "@neverdown/sdk";

const PORT = Number(process.env.SDK_CONSUMER_PORT ?? 3100);
const STEP_MS = Math.max(400, Number(process.env.DEMO_STEP_MS ?? 1100));
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

type StepEvent = {
  type: "step";
  id: string;
  title: string;
  status: "running" | "done" | "fail";
  ok?: boolean;
  detail?: string;
  adds?: string;
  sdkMethod?: string;
  missing?: string;
  improvement?: string;
  elapsedMs?: number;
};

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  res.end(JSON.stringify(body));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function client(): NeverDown {
  return NeverDown.create({ env: process.env });
}

function sellerIdentity() {
  const ensName = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!ensName || !payTo) throw new Error("SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID required");
  return { ensName, payTo };
}

function serializeOffer(offer: CapabilityOfferRow) {
  return {
    entityKey: offer.entityKey,
    sellerens: offer.sellerens,
    serviceurl: offer.serviceurl,
    probeurl: offer.probeurl,
    purchaseurl: offer.purchaseurl,
    rpcurl: offer.rpcurl,
    payto: offer.payto,
    pricetinybars: offer.pricetinybars.toString(),
    chainid: offer.chainid.toString(),
    category: offer.category,
    schemaversion: offer.schemaversion.toString(),
    expiresat: offer.expiresat,
  };
}

async function findMatchingOffer(nd: NeverDown) {
  const { ensName, payTo } = sellerIdentity();
  const seller = await nd.resolveSeller({ ensName, expectedPayTo: payTo });
  const maxPrice = process.env.HEDERA_X402_PRICE_SMALLEST_UNITS || "10000";
  const offers = await nd.discoverOffers({ category: "rpc", maxPriceTinybars: maxPrice, allowedPayTo: [payTo] });
  const x402 = seller.records.x402Url?.replace(/\/+$/, "");
  const offer = offers.find((row) => row.sellerens.toLowerCase() === ensName.toLowerCase() && row.serviceurl === x402);
  if (!offer) throw new Error("No Arkiv offer matches verified ENS seller");
  return { seller, offer };
}

function beginStream(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  const write = (event: Record<string, unknown>) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  return {
    write,
    async step(partial: Omit<StepEvent, "type" | "status"> & { status?: StepEvent["status"] }) {
      const running: StepEvent = { type: "step", status: "running", ...partial, status: "running" };
      write(running);
      await sleep(STEP_MS);
    },
    done(partial: Omit<StepEvent, "type" | "status"> & { ok: boolean; detail: string }) {
      write({
        type: "step",
        status: partial.ok ? "done" : "fail",
        ...partial,
      } satisfies StepEvent);
    },
    meta(event: Record<string, unknown>) {
      write(event);
    },
    end() {
      res.end();
    },
  };
}

let cachedOffer: CapabilityOfferRow | null = null;

async function streamWithout(res: ServerResponse) {
  const stream = beginStream(res);
  const deadUrl = process.env.DEMO_DEAD_RPC_URL || "http://127.0.0.1:9";
  const started = Date.now();
  stream.meta({ type: "start", mode: "without-sdk", usingSdk: false });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const id = `retry-${attempt}`;
    await stream.step({
      id,
      title: `Retry ${attempt} against hard-coded RPC`,
      detail: `POST ${deadUrl}`,
      missing: "no FailureSpotMonitor · no NeverDown",
      adds: "Nothing — still the same dead URL",
    });
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 450);
      await fetch(deadUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      stream.done({
        id,
        title: `Retry ${attempt} against hard-coded RPC`,
        ok: false,
        detail: `still failing after ${Date.now() - t0}ms`,
        missing: "no FailureSpotMonitor · no NeverDown",
        adds: "Nothing — still the same dead URL",
        elapsedMs: Date.now() - t0,
      });
    } catch (error) {
      stream.done({
        id,
        title: `Retry ${attempt} against hard-coded RPC`,
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)} (${Date.now() - t0}ms)`,
        missing: "no FailureSpotMonitor · no NeverDown",
        adds: "Nothing — still the same dead URL",
        elapsedMs: Date.now() - t0,
      });
    }
  }

  await stream.step({
    id: "recovery",
    title: "Attempt recovery",
    detail: "looking for backup…",
    missing: "ENS / Arkiv / prove / procure / install skipped",
    adds: "Nothing — no resilience operator in this app",
  });
  stream.done({
    id: "recovery",
    title: "Attempt recovery",
    ok: false,
    detail: "still on primary · page an operator",
    missing: "ENS / Arkiv / prove / procure / install skipped",
    adds: "Nothing — no resilience operator in this app",
  });

  stream.meta({
    type: "verdict",
    recovered: false,
    usingSdk: false,
    verdict: "STUCK · dependency down · no resilience operator",
    elapsedMs: Date.now() - started,
    improvementsMissing: ["detect", "ens", "discover", "prove", "deny", "procure", "install"],
  });
  stream.meta({ type: "done" });
  stream.end();
}

async function streamWith(res: ServerResponse) {
  const stream = beginStream(res);
  const started = Date.now();
  const nd = client();
  stream.meta({ type: "start", mode: "with-sdk", usingSdk: true, sdkPackage: "@neverdown/sdk" });

  await stream.step({
    id: "detect",
    title: "Detect failure spot",
    detail: "primary RPC timing out",
    sdkMethod: "FailureSpotMonitor.reportFailure()",
    adds: "Incident signal the dApp can act on",
    improvement: "detect",
  });
  const monitor = new FailureSpotMonitor();
  let incident: { incidentId: string; spotId: string; reason: string; occurredAt: string } | null = null;
  monitor.register({
    id: "acme-rpc-primary",
    failureThreshold: 2,
    probe: async () => false,
    onIncident: async (event) => { incident = event; },
  });
  await monitor.reportFailure("acme-rpc-primary", "primary RPC timeout");
  const fired = await monitor.reportFailure("acme-rpc-primary", "primary RPC timeout again");
  incident = fired ?? incident;
  stream.done({
    id: "detect",
    title: "Detect failure spot",
    ok: Boolean(incident),
    detail: incident ? `${incident.incidentId} · ${incident.reason}` : "no incident",
    sdkMethod: "FailureSpotMonitor.reportFailure()",
    adds: "Incident signal the dApp can act on",
    improvement: "detect",
  });
  if (incident) stream.meta({ type: "improve", key: "detect" });

  const { ensName, payTo } = sellerIdentity();
  await stream.step({
    id: "ens",
    title: "Verify seller via ENS",
    detail: `resolve ${ensName} texts + payTo match`,
    sdkMethod: "NeverDown.resolveSeller()",
    adds: "Trust root — only allowlisted sellers",
    improvement: "ens",
  });
  const seller = await nd.resolveSeller({ ensName, expectedPayTo: payTo });
  stream.done({
    id: "ens",
    title: "Verify seller via ENS",
    ok: true,
    detail: `${seller.normalizedEnsName} → ${seller.records.hederaAccount}`,
    sdkMethod: "NeverDown.resolveSeller()",
    adds: "Trust root — only allowlisted sellers",
    improvement: "ens",
  });
  stream.meta({ type: "improve", key: "ens", ensName: seller.normalizedEnsName });

  await stream.step({
    id: "deny",
    title: "Fail closed on spoofed payTo",
    detail: "expectedPayTo = 0.0.99999999",
    sdkMethod: "NeverDown.resolveSeller(expectedPayTo)",
    adds: "Blocks paying the wrong Hedera account",
    improvement: "deny",
  });
  try {
    await nd.resolveSeller({ ensName, expectedPayTo: "0.0.99999999" });
    stream.done({
      id: "deny",
      title: "Fail closed on spoofed payTo",
      ok: false,
      detail: "unexpectedly accepted spoofed payTo",
      sdkMethod: "NeverDown.resolveSeller(expectedPayTo)",
      adds: "Blocks paying the wrong Hedera account",
      improvement: "deny",
    });
  } catch (error) {
    stream.done({
      id: "deny",
      title: "Fail closed on spoofed payTo",
      ok: true,
      detail: error instanceof Error ? error.message : String(error),
      sdkMethod: "NeverDown.resolveSeller(expectedPayTo)",
      adds: "Blocks paying the wrong Hedera account",
      improvement: "deny",
    });
    stream.meta({ type: "improve", key: "deny" });
  }

  await stream.step({
    id: "discover",
    title: "Discover offer on Arkiv",
    detail: "category=rpc · match ENS x402 URL",
    sdkMethod: "NeverDown.discoverOffers()",
    adds: "Live market of capability offers",
    improvement: "discover",
  });
  const { offer } = await findMatchingOffer(nd);
  cachedOffer = offer;
  stream.done({
    id: "discover",
    title: "Discover offer on Arkiv",
    ok: true,
    detail: `${offer.category} · ${offer.pricetinybars.toString()} tinybars · ${offer.sellerens}`,
    sdkMethod: "NeverDown.discoverOffers()",
    adds: "Live market of capability offers",
    improvement: "discover",
  });
  stream.meta({ type: "improve", key: "discover", offer: serializeOffer(offer) });

  await stream.step({
    id: "prove",
    title: "Prove capability before pay",
    detail: `probe ${offer.probeurl}`,
    sdkMethod: "NeverDown.proveCapability()",
    adds: "Won't pay for a dead / wrong-chain endpoint",
    improvement: "prove",
  });
  const proof = await nd.proveCapability({
    rpcUrl: offer.probeurl,
    expectedChainId: Number(offer.chainid),
    payTo: offer.payto,
    ensPayTo: seller.records.hederaAccount!,
  });
  stream.done({
    id: "prove",
    title: "Prove capability before pay",
    ok: proof.pass,
    detail: proof.pass ? `pass · ${proof.latencyMs ?? "?"}ms` : "capability checks failed",
    sdkMethod: "NeverDown.proveCapability()",
    adds: "Won't pay for a dead / wrong-chain endpoint",
    improvement: "prove",
  });
  if (proof.pass) stream.meta({ type: "improve", key: "prove", proof });

  const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/+$/, "");
  await stream.step({
    id: "ready",
    title: "Check gateway install plane",
    detail: `${gatewayUrl}/_internal/ready`,
    sdkMethod: "getGatewayStatus()",
    adds: "Confirms there is somewhere to install standby",
  });
  let gateway = null;
  try { gateway = await getGatewayStatus(gatewayUrl); } catch { gateway = null; }
  stream.done({
    id: "ready",
    title: "Check gateway install plane",
    ok: Boolean(gateway?.ready?.ready),
    detail: gateway?.ready?.ready
      ? `ready · active=${gateway.status.active} · providers=${gateway.status.providers?.length ?? "?"}`
      : "gateway not ready — start pnpm gateway:live",
    sdkMethod: "getGatewayStatus()",
    adds: "Confirms there is somewhere to install standby",
  });

  stream.meta({
    type: "verdict",
    recovered: proof.pass && Boolean(incident),
    usingSdk: true,
    verdict: proof.pass
      ? "RAILS READY · next: live procure pays + installs standby"
      : "SDK rails incomplete · capability proof failed",
    elapsedMs: Date.now() - started,
    seller,
    offer: serializeOffer(offer),
    proof,
    incident,
    gateway,
  });
  stream.meta({ type: "done" });
  stream.end();
}

async function streamProcure(res: ServerResponse) {
  const stream = beginStream(res);
  const started = Date.now();
  const nd = client();
  stream.meta({ type: "start", mode: "procure", usingSdk: true });

  await stream.step({
    id: "offer",
    title: "Load matched Arkiv offer",
    detail: "reuse verified offer or rediscover",
    sdkMethod: "NeverDown.discoverOffers()",
    adds: "Exact offer the worker will pay",
  });
  const { offer } = cachedOffer ? { offer: cachedOffer } : await findMatchingOffer(nd);
  cachedOffer = offer;
  stream.done({
    id: "offer",
    title: "Load matched Arkiv offer",
    ok: true,
    detail: `${offer.purchaseurl} · ${offer.pricetinybars.toString()} tinybars → ${offer.payto}`,
    sdkMethod: "NeverDown.discoverOffers()",
    adds: "Exact offer the worker will pay",
  });

  await stream.step({
    id: "preflight",
    title: "Preflight gateway before spend",
    detail: "TOKEN + /_internal/ready must be green",
    sdkMethod: "NeverDown.procure() preflight",
    adds: "No HBAR leave the wallet if install plane is down",
  });
  const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/+$/, "");
  let before = null;
  try { before = await getGatewayStatus(gatewayUrl); } catch { before = null; }
  stream.done({
    id: "preflight",
    title: "Preflight gateway before spend",
    ok: Boolean(before?.ready?.ready),
    detail: before?.ready?.ready
      ? `active=${before.status.active} · redundancy=${before.status.redundancy}`
      : "gateway install API unavailable",
    sdkMethod: "NeverDown.procure() preflight",
    adds: "No HBAR leave the wallet if install plane is down",
  });

  await stream.step({
    id: "worker",
    title: "Payment worker IPC (x402)",
    detail: "settle Hedera cryptoTransfer via payment worker — this takes real network time",
    sdkMethod: "startPaymentWorker → requestPurchase",
    adds: "Spend keys stay in worker env · not in this UI process",
    improvement: "procure",
  });
  stream.meta({ type: "progress", message: "Waiting on Hedera settle + seller entitlement…" });

  const receipt = await nd.procure({
    incidentId: `acme-ui-${Date.now()}`,
    serviceId: "neverdown-rpc-pack",
    offer,
  });
  const settled = receipt.status === "SETTLED";
  const links = receipt.transactionId
    ? evidenceLinks({ transactionId: receipt.transactionId, topicId: process.env.HEDERA_TOPIC_ID?.trim() })
    : null;

  stream.done({
    id: "worker",
    title: "Payment worker IPC (x402)",
    ok: settled,
    detail: settled
      ? `SETTLED · tx ${receipt.transactionId}`
      : `${receipt.status}${receipt.denyReason ? ` · ${receipt.denyReason}` : ""}`,
    sdkMethod: "startPaymentWorker → requestPurchase",
    adds: "On-chain payment evidence (HashScan)",
    improvement: "procure",
    elapsedMs: Date.now() - started,
  });
  if (settled) stream.meta({ type: "improve", key: "procure" });

  await stream.step({
    id: "evidence",
    title: "Record payment evidence",
    detail: "HashScan + HCS topic links",
    sdkMethod: "evidenceLinks()",
    adds: "Judges can open the tx in a browser",
  });
  stream.done({
    id: "evidence",
    title: "Record payment evidence",
    ok: Boolean(links?.hashscan || receipt.hashscanUrl),
    detail: links?.hashscan || receipt.hashscanUrl || "no hashscan url",
    sdkMethod: "evidenceLinks()",
    adds: "Judges can open the tx in a browser",
  });
  if (links?.hashscan || receipt.hashscanUrl) {
    stream.meta({ type: "link", href: links?.hashscan || receipt.hashscanUrl, label: "HashScan payment" });
  }

  await stream.step({
    id: "install",
    title: "Install standby on gateway",
    detail: "POST /_internal/install-standby with entitlement",
    sdkMethod: "NeverDown.procure() → gateway install",
    adds: "Standby RPC endpoint now in the fast plane",
    improvement: "install",
  });
  stream.done({
    id: "install",
    title: "Install standby on gateway",
    ok: receipt.installed === true,
    detail: receipt.installed
      ? `installed · rpc=${offer.rpcurl}`
      : `not installed${receipt.installError ? ` · ${receipt.installError}` : ""}`,
    sdkMethod: "NeverDown.procure() → gateway install",
    adds: "Standby RPC endpoint now in the fast plane",
    improvement: "install",
  });
  if (receipt.installed) stream.meta({ type: "improve", key: "install" });

  await stream.step({
    id: "verify",
    title: "Verify gateway after install",
    detail: "re-read providers / active / redundancy",
    sdkMethod: "getGatewayStatus()",
    adds: "Proof the fast plane gained capacity",
  });
  let after = null;
  try { after = await getGatewayStatus(gatewayUrl); } catch { after = null; }
  stream.done({
    id: "verify",
    title: "Verify gateway after install",
    ok: Boolean(after?.ready?.ready),
    detail: after?.ready?.ready
      ? `active=${after.status.active} · providers=${after.status.providers?.length ?? "?"} · redundancy=${after.status.redundancy}`
      : "could not re-read gateway",
    sdkMethod: "getGatewayStatus()",
    adds: "Proof the fast plane gained capacity",
  });

  const ok = settled && receipt.installed === true;
  stream.meta({
    type: "verdict",
    recovered: ok,
    usingSdk: true,
    verdict: ok
      ? "RECOVERED · paid on Hedera · standby installed on gateway"
      : `Procure ${receipt.status}${receipt.installed ? "" : " · install incomplete"}`,
    elapsedMs: Date.now() - started,
    receipt,
    links,
    offer: serializeOffer(offer),
    gatewayBefore: before,
    gatewayAfter: after,
  });
  stream.meta({ type: "done" });
  stream.end();
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
  try {
    if (pathname === "/api/bootstrap" && req.method === "GET") {
      const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/+$/, "");
      let gateway = null;
      try { gateway = await getGatewayStatus(gatewayUrl); } catch { gateway = null; }
      send(res, 200, {
        ensName: process.env.SELLER_ENS_NAME || null,
        gatewayUrl,
        gateway,
        sdkPackage: "@neverdown/sdk",
        stepMs: STEP_MS,
        note: "Acme Ops is a separate consumer of @neverdown/sdk",
      });
      return;
    }

    if (pathname === "/api/demo/without" && req.method === "POST") {
      await streamWithout(res);
      return;
    }

    if (pathname === "/api/demo/with" && req.method === "POST") {
      await streamWith(res);
      return;
    }

    if (pathname === "/api/procure" && req.method === "POST") {
      await streamProcure(res);
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (error) {
    if (!res.headersSent) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      res.write(`${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) })}\n`);
      res.write(`${JSON.stringify({ type: "done" })}\n`);
    } catch { /* ignore */ }
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url.pathname);
    return;
  }
  const filePath = url.pathname === "/" ? join(PUBLIC, "index.html") : join(PUBLIC, url.pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(PUBLIC) || !existsSync(filePath)) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const ext = extname(filePath);
  send(res, 200, readFileSync(filePath), MIME[ext] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.log(`Acme Ops (SDK consumer UI) → http://127.0.0.1:${PORT}`);
  console.log(`Step pacing ${STEP_MS}ms · @neverdown/sdk server-side only`);
});
