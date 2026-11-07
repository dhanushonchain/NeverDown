/** Live Sepolia failover acceptance with an isolated primary outage proxy. No payment or agent. */
import { createServer, type Server } from "node:http";
import { createGatewayApp } from "../apps/gateway/src/app.js";
import { loadGatewayConfig } from "../apps/gateway/src/config.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server has no TCP address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(label: string, condition: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

async function rpc(base: string, method: "eth_chainId" | "eth_blockNumber"): Promise<string> {
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(7_000),
  });
  const data = await response.json() as { result?: unknown; error?: unknown };
  if (!response.ok || typeof data.result !== "string" || data.error) throw new Error(`${method} did not return a result`);
  return data.result;
}

async function main(): Promise<void> {
  const configured = loadGatewayConfig(process.env);
  const primary = configured.providers.find((provider) => provider.id === "primary");
  const standby = configured.providers.find((provider) => provider.id === "standby");
  if (!primary || !standby) throw new Error("Two independent configured providers are required");

  let primaryFailed = false;
  const proxy = createServer(async (request, response) => {
    if (primaryFailed) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "injected primary outage" }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(primary.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(6_000),
      });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end();
    }
  });

  let gateway: Server | undefined;
  let controller: ReturnType<typeof createGatewayApp>["controller"] | undefined;
  try {
    const proxyUrl = await listen(proxy);
    const config = {
      ...configured,
      providers: [{ id: "primary", url: proxyUrl }, standby],
      healthIntervalMs: 500,
      failureThreshold: 2,
      recoveryThreshold: 2,
      failoverCooldownMs: 0,
      internalApiEnabled: false,
      internalToken: undefined,
    };
    const created = createGatewayApp({ config });
    controller = created.controller;
    gateway = createServer(created.app);
    const gatewayUrl = await listen(gateway);
    controller.start();

    await waitFor("both live providers", async () =>
      controller!.getStatus("primary")?.healthy === true &&
      controller!.getStatus("standby")?.healthy === true &&
      controller!.activeProvider() === "primary",
    );
    const before = await rpc(gatewayUrl, "eth_chainId");
    if (before !== `0x${config.chainId.toString(16)}`) throw new Error("primary returned wrong chain");

    primaryFailed = true;
    await waitFor("standby failover", async () =>
      controller!.activeProvider() === "standby" &&
      controller!.getStatus("primary")?.healthy === false &&
      controller!.getStatus("standby")?.healthy === true,
    );
    const after = await rpc(gatewayUrl, "eth_chainId");
    const block = await rpc(gatewayUrl, "eth_blockNumber");
    const event = controller.recentEvents().find((item) =>
      item.reason === "failover completed" && item.oldActive === "primary" && item.newActive === "standby",
    );
    if (after !== before || !/^0x[0-9a-f]+$/i.test(block) || !event) throw new Error("standby read or failover evidence missing");
    console.log(JSON.stringify({
      result: "PASS",
      chainId: after,
      activeAfterOutage: controller.activeProvider(),
      standbyBlockNumber: block,
      failoverEventId: event.id,
      paymentStarted: false,
    }));
  } finally {
    controller?.stop();
    if (gateway) await close(gateway);
    await close(proxy);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "live failover acceptance failed");
  process.exitCode = 1;
});
