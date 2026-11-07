/**
 * Separate consumer app — imports ONLY @neverdown/sdk.
 * Not the NeverDown console (apps/web). Live procure → HashScan.
 */
import { NeverDown } from "@neverdown/sdk";

async function main(): Promise<void> {
  console.log("neverdown-sdk-consumer · procure · live");
  console.log("This app is NOT the NeverDown console — it only uses @neverdown/sdk.\n");

  const nd = NeverDown.create({ env: process.env });
  const name = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!name || !payTo) throw new Error("SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID are required");

  const seller = await nd.resolveSeller({ ensName: name, expectedPayTo: payTo });
  console.log("ENS ok:", seller.normalizedEnsName, seller.records.x402Url);

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
  console.log("Offer:", offer.entityKey, "price", offer.pricetinybars.toString());

  const receipt = await nd.procure({
    incidentId: `sdk-consumer-${Date.now()}`,
    serviceId: "neverdown-rpc-pack",
    offer,
  });

  console.log(JSON.stringify({
    status: receipt.status,
    installed: receipt.installed,
    purchaseId: receipt.purchaseId,
    transactionId: receipt.transactionId,
    hashscanUrl: receipt.hashscanUrl,
    auditStatus: receipt.auditStatus,
    denyReason: receipt.denyReason,
    installError: receipt.installError,
  }, null, 2));

  if (receipt.status !== "SETTLED") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
