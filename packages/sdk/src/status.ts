/** Read-only entry point safe for console/browser bundles. No worker or signing imports. */
export type GatewaySnapshot = {
  ready: { ready: boolean; active?: string | null; providers?: number };
  status: {
    active: string | null;
    routingMode?: string;
    providers: Array<{ id: string; healthy: boolean; reason?: string | null }>;
    recentEvents?: Array<{ id?: string; incidentId?: string; reason?: string }>;
  };
};

export async function getGatewayStatus(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<GatewaySnapshot> {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("gateway URL must be a base URL without credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("gateway URL must use HTTPS except localhost");
  const [readyResponse, statusResponse] = await Promise.all(["ready", "status"].map((path) => fetchImpl(`${url.origin}/${path}`, { method: "GET", signal: AbortSignal.timeout(5000) })));
  if (!readyResponse.ok && readyResponse.status !== 503) throw new Error(`gateway readiness HTTP ${readyResponse.status}`);
  if (!statusResponse.ok) throw new Error(`gateway status HTTP ${statusResponse.status}`);
  const ready = await readyResponse.json() as GatewaySnapshot["ready"];
  const status = await statusResponse.json() as GatewaySnapshot["status"];
  if (typeof ready?.ready !== "boolean" || !Array.isArray(status?.providers) || typeof status.active !== "string" && status.active !== null) throw new Error("invalid gateway status response");
  return { ready, status };
}

export function evidenceLinks(input: { transactionId: string; topicId?: string }): { hashscan: string; topic?: string } {
  if (!/^0\.0\.\d+@\d+\.\d+$/.test(input.transactionId)) throw new Error("invalid Hedera transaction ID");
  if (input.topicId && !/^0\.0\.\d+$/.test(input.topicId)) throw new Error("invalid HCS topic ID");
  return {
    hashscan: `https://hashscan.io/testnet/transaction/${encodeURIComponent(input.transactionId)}`,
    ...(input.topicId ? { topic: `https://hashscan.io/testnet/topic/${input.topicId}` } : {}),
  };
}
