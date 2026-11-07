/** Capped SDK purchase acceptance on Hedera testnet. Requires a configured private .env. */
import { randomUUID } from "node:crypto";
import { createGatewayApp } from "../apps/gateway/src/app.js";
import { loadGatewayConfig } from "../apps/gateway/src/config.js";
import { NeverDown } from "../packages/sdk/src/index.js";

async function main(): Promise<void> {
  const name = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  const price = process.env.HEDERA_X402_PRICE_SMALLEST_UNITS?.trim();
  const serviceId = process.env.POLICY_SERVICES?.split(/[,\s;]+/).find(Boolean) || "neverdown-rpc-pack";
  if (!name || !payTo || !price) throw new Error("seller name, recipient, and configured price are required");

  const { app, controller } = createGatewayApp({ config: loadGatewayConfig(process.env) });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      if (server.listening) return resolve();
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    controller.start();

    const nd = NeverDown.create({ env: { ...process.env, GATEWAY_URL: gatewayUrl } });
    const seller = await nd.resolveSeller({ ensName: name, expectedPayTo: payTo });
    const offers = await nd.discoverOffers({
      category: "rpc",
      maxPriceTinybars: price,
      allowedPayTo: [payTo],
    });
    const offer = offers.find((row) =>
      row.sellerens.toLowerCase() === name.toLowerCase() &&
      row.serviceurl === seller.records.x402Url &&
      row.payto === payTo,
    );
    if (!offer) throw new Error("no current Arkiv offer matches the verified ENS seller");
    const proof = await nd.proveCapability({
      rpcUrl: offer.probeurl,
      expectedChainId: Number(offer.chainid),
      payTo: offer.payto,
      ensPayTo: seller.records.hederaAccount!,
    });
    if (!proof.pass) throw new Error("selected offer failed independent capability proof");
    if (!controller.getStatus("primary")?.healthy && !controller.getStatus("standby")?.healthy) {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    if (!controller.getStatus("primary")?.healthy && !controller.getStatus("standby")?.healthy) {
      throw new Error("isolated gateway has no healthy provider");
    }

    const incidentId = `sdk-live:${randomUUID()}`;
    console.log(JSON.stringify({ phase: "purchase_requested", incidentId, offerEntityKey: offer.entityKey, maxTinybars: price }));
    const receipt = await nd.procure({ incidentId, serviceId, offer });
    const standbyInstalled = controller.getStatus("standby")?.url === offer.rpcurl;
    console.log(JSON.stringify({ phase: "purchase_result", receipt, standbyInstalled }));
    if (receipt.status !== "SETTLED" || !receipt.installed || !receipt.transactionId || !standbyInstalled) {
      throw new Error(receipt.status === "SETTLED" || receipt.status === "UNCERTAIN"
        ? "SDK live acceptance needs reconciliation before retrying"
        : "SDK live acceptance was denied or released before settlement");
    }
  } finally {
    controller.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "SDK live acceptance failed");
  process.exitCode = 1;
});
