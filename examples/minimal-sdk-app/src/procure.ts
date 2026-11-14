/**
 * Optional capped procure. Requires:
 * - .env.host with GATEWAY_* + PAYMENT_WORKER_ENV_FILE
 * - mode-0600 worker file (see packages/sdk/env.worker.example)
 * - running gateway with GATEWAY_INTERNAL_API=true
 * - live seller + Arkiv offer
 */
import { NeverDown } from "@neverdown/sdk";
import { loadEnvFile } from "./loadEnv.js";

loadEnvFile(".env.host");
loadEnvFile(".env");

async function main(): Promise<void> {
  const name = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!name || !payTo) throw new Error("SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID are required");
  if (!process.env.PAYMENT_WORKER_ENV_FILE) {
    throw new Error("PAYMENT_WORKER_ENV_FILE is required (path to mode-0600 worker secrets file)");
  }

  const nd = NeverDown.create({ env: process.env });
  const seller = await nd.resolveSeller({ ensName: name, expectedPayTo: payTo });
  const maxPrice = process.env.HEDERA_X402_PRICE_SMALLEST_UNITS || "10000";
  const offers = await nd.discoverOffers({
    category: "rpc",
    maxPriceTinybars: maxPrice,
    allowedPayTo: [payTo],
  });
  const offer = offers.find(
    (row) =>
      row.sellerens.toLowerCase() === name.toLowerCase() &&
      row.serviceurl === seller.records.x402Url?.replace(/\/+$/, ""),
  );
  if (!offer) throw new Error("No Arkiv offer matches the verified ENS seller");

  const receipt = await nd.procure({
    incidentId: `minimal-sdk-${Date.now()}`,
    serviceId: process.env.POLICY_SERVICES?.split(/[,\s]+/)[0]?.trim() || "neverdown-rpc-pack",
    offer,
  });

  console.log(
    JSON.stringify(
      {
        status: receipt.status,
        installed: receipt.installed,
        purchaseId: receipt.purchaseId,
        transactionId: receipt.transactionId,
        hashscanUrl: receipt.hashscanUrl,
        auditStatus: receipt.auditStatus,
        denyReason: receipt.denyReason,
        installError: receipt.installError,
      },
      null,
      2,
    ),
  );

  if (receipt.status !== "SETTLED") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
