/** Read-only live SDK acceptance; no worker, signing, or payment. */
import { NeverDown } from "../packages/sdk/src/index.js";

async function main() {
  const nd = NeverDown.create({ env: process.env });
  const name = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!name || !payTo) throw new Error("SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID are required");
  const seller = await nd.resolveSeller({ ensName: name, expectedPayTo: payTo });
  const offers = await nd.discoverOffers({ category: "rpc", maxPriceTinybars: process.env.HEDERA_X402_PRICE_SMALLEST_UNITS || "10000", allowedPayTo: [payTo] });
  const offer = offers.find((row) => row.sellerens.toLowerCase() === name.toLowerCase() && row.serviceurl === seller.records.x402Url);
  if (!offer) throw new Error("No offer matches the verified ENS seller");
  const proof = await nd.proveCapability({ rpcUrl: offer.probeurl, expectedChainId: Number(offer.chainid), payTo: offer.payto, ensPayTo: seller.records.hederaAccount! });
  if (!proof.pass) throw new Error(`Capability proof failed: ${proof.checks.filter((check) => !check.pass).map((check) => check.name).join(", ")}`);
  console.log(`SDK read-only smoke passed: ${name} ${offer.entityKey}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "SDK smoke failed");
  process.exitCode = 1;
});
