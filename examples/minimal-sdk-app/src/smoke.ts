/**
 * 10-minute read-only path: ENS → Arkiv → Proof-of-Capability.
 * No payment worker. No Hedera spend keys in this process.
 */
import { NeverDown } from "@neverdown/sdk";
import { loadEnvFile } from "./loadEnv.js";

loadEnvFile(".env.host");
loadEnvFile(".env");

async function main(): Promise<void> {
  if (!process.env.ENS_RPC_URL?.trim() || !process.env.ENS_ALLOWLIST_NAMES?.trim()) {
    console.log("smoke skipped: missing host env.");
    console.log("  1. From repo root: pnpm sdk:pack");
    console.log("  2. cd examples/minimal-sdk-app && pnpm install --ignore-workspace");
    console.log("  3. cp ../../packages/sdk/env.host.example .env.host  (fill ENS + Arkiv + POC)");
    console.log("  4. pnpm smoke");
    return;
  }

  const name = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!name || !payTo) {
    console.log("smoke skipped: set SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID in .env.host");
    return;
  }

  const nd = NeverDown.create({ env: process.env });
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

  const proof = await nd.proveCapability({
    rpcUrl: offer.probeurl,
    expectedChainId: Number(offer.chainid),
    payTo: offer.payto,
    ensPayTo: seller.records.hederaAccount!,
  });
  if (!proof.pass) {
    throw new Error(
      `Capability proof failed: ${proof.checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}`,
    );
  }
  console.log("Proof ok — read-only smoke passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
