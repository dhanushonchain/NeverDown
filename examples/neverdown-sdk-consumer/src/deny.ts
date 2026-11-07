/**
 * Separate consumer app — imports ONLY @neverdown/sdk.
 * Shows fail-closed identity: wrong payTo never proceeds to settle.
 */
import { NeverDown } from "@neverdown/sdk";

async function main(): Promise<void> {
  console.log("neverdown-sdk-consumer · deny · live");
  console.log("This app is NOT the NeverDown console — it only uses @neverdown/sdk.\n");

  const nd = NeverDown.create({ env: process.env });
  const name = process.env.SELLER_ENS_NAME?.trim();
  if (!name) throw new Error("SELLER_ENS_NAME is required");

  const badPayTo = "0.0.99999999";
  try {
    await nd.resolveSeller({ ensName: name, expectedPayTo: badPayTo });
    console.error("UNEXPECTED: resolveSeller accepted a bad payTo");
    process.exitCode = 1;
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      approved: false,
      denyReason: "ENS_PAYTO_MISMATCH",
      message,
      badPayTo,
      ensName: name,
    }, null, 2));
    console.log("\nDenied before any Hedera settle (fail closed).");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
