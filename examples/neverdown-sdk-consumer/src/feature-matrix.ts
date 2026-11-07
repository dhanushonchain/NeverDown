/**
 * Exhaustive SDK feature check from a separate consumer app.
 * Imports only @neverdown/sdk and @neverdown/sdk/status.
 */
import { NeverDown, FailureSpotMonitor } from "@neverdown/sdk";
import { getGatewayStatus, evidenceLinks } from "@neverdown/sdk/status";

type Row = { name: string; ok: boolean; detail?: string };
const rows: Row[] = [];
function pass(name: string, detail?: string) { rows.push({ name, ok: true, detail }); }
function fail(name: string, detail?: string) { rows.push({ name, ok: false, detail }); }

async function main(): Promise<void> {
  console.log("SDK feature matrix · consumer = examples/neverdown-sdk-consumer\n");

  // 1) create rejects spend keys in parent
  try {
    NeverDown.create({ env: { ...process.env, HEDERA_SPEND_KEY: "should-not-be-here" } });
    fail("create_rejects_spend_key", "did not throw");
  } catch (e) {
    pass("create_rejects_spend_key", e instanceof Error ? e.message : String(e));
  }

  // 2) create with clean env
  let nd: NeverDown;
  try {
    nd = NeverDown.create({ env: process.env });
    pass("create_ok");
  } catch (e) {
    fail("create_ok", e instanceof Error ? e.message : String(e));
    printAndExit();
    return;
  }

  const name = process.env.SELLER_ENS_NAME?.trim() || "";
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim() || "";
  if (!name || !payTo) {
    fail("env_seller_identity", "SELLER_ENS_NAME / HEDERA_MERCHANT_ACCOUNT_ID missing");
    printAndExit();
    return;
  }

  // 3) resolveSeller happy path
  let seller;
  try {
    seller = await nd.resolveSeller({ ensName: name, expectedPayTo: payTo });
    pass("resolveSeller", `${seller.normalizedEnsName} → ${seller.records.x402Url}`);
  } catch (e) {
    fail("resolveSeller", e instanceof Error ? e.message : String(e));
    printAndExit();
    return;
  }

  // 4) resolveSeller fail-closed (bad payTo)
  try {
    await nd.resolveSeller({ ensName: name, expectedPayTo: "0.0.99999999" });
    fail("resolveSeller_deny_bad_payTo", "accepted bad payTo");
  } catch (e) {
    pass("resolveSeller_deny_bad_payTo", e instanceof Error ? e.message : String(e));
  }

  // 5) resolveSeller fail-closed (not allowlisted)
  try {
    await nd.resolveSeller({ ensName: "evil.example.eth", expectedPayTo: payTo });
    fail("resolveSeller_deny_not_allowlisted", "accepted unknown ENS");
  } catch (e) {
    pass("resolveSeller_deny_not_allowlisted", e instanceof Error ? e.message : String(e));
  }

  // 6) discoverOffers
  let offer;
  try {
    const maxPrice = process.env.HEDERA_X402_PRICE_SMALLEST_UNITS || "10000";
    const offers = await nd.discoverOffers({
      category: "rpc",
      maxPriceTinybars: maxPrice,
      allowedPayTo: [payTo],
    });
    offer = offers.find(
      (row) =>
        row.sellerens.toLowerCase() === name.toLowerCase() &&
        row.serviceurl === seller!.records.x402Url?.replace(/\/+$/, ""),
    );
    if (!offer) throw new Error(`no matching offer among ${offers.length}`);
    pass("discoverOffers", `${offer.entityKey} @ ${offer.pricetinybars.toString()}`);
  } catch (e) {
    fail("discoverOffers", e instanceof Error ? e.message : String(e));
  }

  // 7) proveCapability
  if (offer) {
    try {
      const proof = await nd.proveCapability({
        rpcUrl: offer.probeurl,
        expectedChainId: Number(offer.chainid),
        payTo: offer.payto,
        ensPayTo: seller!.records.hederaAccount!,
      });
      if (!proof.pass) throw new Error(proof.checks.filter((c) => !c.pass).map((c) => c.name).join(","));
      pass("proveCapability", `latency=${proof.latencyMs ?? "n/a"}ms`);
    } catch (e) {
      fail("proveCapability", e instanceof Error ? e.message : String(e));
    }
  } else {
    fail("proveCapability", "skipped — no offer");
  }

  // 8) status entry — evidenceLinks
  try {
    const links = evidenceLinks({ transactionId: "0.0.9185802@1794003759.391936313", topicId: process.env.HEDERA_TOPIC_ID?.trim() });
    if (!links.hashscan.includes("hashscan.io")) throw new Error("bad hashscan url");
    pass("status_evidenceLinks", links.hashscan);
  } catch (e) {
    fail("status_evidenceLinks", e instanceof Error ? e.message : String(e));
  }

  // 9) status entry — getGatewayStatus
  const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/+$/, "");
  try {
    const snap = await getGatewayStatus(gatewayUrl);
    pass("status_getGatewayStatus", `ready=${snap.ready.ready} active=${snap.status.active} providers=${snap.status.providers.length}`);
  } catch (e) {
    fail("status_getGatewayStatus", e instanceof Error ? e.message : String(e));
  }

  // 10) FailureSpotMonitor
  try {
    const monitor = new FailureSpotMonitor();
    let incidents = 0;
    monitor.register({
      id: "demo-spot",
      failureThreshold: 2,
      probe: async () => false,
      onIncident: async () => { incidents += 1; },
    });
    await monitor.reportFailure("demo-spot", "first");
    const second = await monitor.reportFailure("demo-spot", "second");
    if (!second || incidents !== 1) throw new Error(`expected one incident, got incidents=${incidents} second=${!!second}`);
    monitor.reportHealthy("demo-spot");
    const st = monitor.status("demo-spot");
    if (st.incidentActive || st.consecutiveFailures !== 0) throw new Error("healthy reset failed");
    pass("FailureSpotMonitor", "threshold + reset ok");
  } catch (e) {
    fail("FailureSpotMonitor", e instanceof Error ? e.message : String(e));
  }

  // 11) procure (live settle) — optional via --procure
  if (process.argv.includes("--procure") && offer) {
    try {
      const receipt = await nd.procure({
        incidentId: `sdk-matrix-${Date.now()}`,
        serviceId: "neverdown-rpc-pack",
        offer,
      });
      if (receipt.status !== "SETTLED") throw new Error(`${receipt.status} ${receipt.denyReason || receipt.installError || ""}`);
      pass("procure", `${receipt.transactionId} installed=${receipt.installed} ${receipt.hashscanUrl || ""}`);
    } catch (e) {
      fail("procure", e instanceof Error ? e.message : String(e));
    }
  } else {
    pass("procure", "skipped (pass --procure to settle on Hedera)");
  }

  printAndExit();
}

function printAndExit(): void {
  console.log("\n=== RESULTS ===");
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
  }
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
