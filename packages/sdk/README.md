# @neverdown/sdk

Server-side client for NeverDown's programmable resilience operator. The current procurement adapter handles RPC failure spots on Ethereum Sepolia, with ENS seller identity, Arkiv offers, independent capability proof, Hedera testnet x402 payment, and a gateway standby install.

Requires Node.js 22.13 or newer because the payment ledger uses Node's built-in SQLite module. The SDK does not run a Hedera spending wallet in a browser. The status-only `@neverdown/sdk/status` entry has no signing imports.

## Install after an npm release

```bash
npm install @neverdown/sdk
```

The package depends on `@neverdown/core`. For a local monorepo checkout, run `pnpm install` at the repository root.

The packages are not yet on npm. To try the built artifacts now, run `pnpm --filter @neverdown/core build`, `pnpm --filter @neverdown/sdk build`, and `pnpm pack` in each package directory. Install both generated tarballs into a separate Node project before publishing.

## Read-only example

```ts
import { NeverDown } from "@neverdown/sdk";

const nd = NeverDown.create({ env: process.env });
const offers = await nd.discoverOffers({ category: "rpc", maxPriceTinybars: 10000n });
for (const offer of offers) {
  const seller = await nd.resolveSeller({ ensName: offer.sellerens, expectedPayTo: offer.payto });
  if (seller.records.x402Url !== offer.serviceurl) continue;
  const proof = await nd.proveCapability({
    rpcUrl: offer.probeurl,
    expectedChainId: Number(offer.chainid),
    payTo: offer.payto,
    ensPayTo: seller.records.hederaAccount!,
  });
  if (proof.pass) console.log("Verified offer", offer.entityKey);
}
```

Set `ENS_RPC_URL` to an Ethereum mainnet HTTPS RPC, `ENS_ALLOWLIST_NAMES` to the names your policy accepts, `POC_REFERENCE_RPC` to an independent Sepolia RPC, and optionally `ARKIV_ACCESS_KEY`, `ARKIV_RPC`, and `ARKIV_CHAIN_ID`. The allowlist cannot be empty. The seller is checked against ENS before payment. Run the repository's `pnpm sdk:smoke` for a read-only live check using the ignored root `.env`.

## Procure a standby

```ts
const offer = (await nd.discoverOffers({ category: "rpc", maxPriceTinybars: 10000n }))[0];
if (!offer) throw new Error("No approved offer");

const receipt = await nd.procure({
  incidentId: "incident-2026-11-07-001",
  serviceId: "rpc-main",
  offer,
});
console.log(receipt.status, receipt.installed, receipt.hashscanUrl);
```

Before calling `procure`, set `PAYMENT_WORKER_ENV_FILE` to a **mode 0600** file outside the public app. That file contains `HEDERA_SPEND_ID`, `HEDERA_SPEND_KEY`, `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_TOPIC_ID`, `POLICY_ALLOWLIST`, `POLICY_ENDPOINTS`, `POLICY_MAX_PER_PAYMENT_TINYBARS`, `POLICY_TOTAL_BUDGET_TINYBARS`, and a persistent `POLICY_DB_PATH`. Set `GATEWAY_URL` and a `GATEWAY_INTERNAL_TOKEN` of at least 20 characters in the SDK process. The SDK process must **not** contain the Hedera signing keys; `NeverDown.create` rejects them. The worker reads the protected file only after it starts.

`procure` rechecks the Arkiv entity, ENS texts, and live capability before starting the payment worker. It only supports `category: "rpc"` today. The worker enforces the policy and budget, settles on Hedera testnet, and returns a bounded entitlement that the SDK sends directly to the gateway. The returned receipt omits that token. If settlement succeeds but installation fails, the receipt keeps the transaction ID and says `installed: false`; reconcile that purchase before retrying. A worker transport failure returns `UNCERTAIN` for the same reason. Use a stable incident ID to prevent duplicate purchases.

Before payment, the SDK checks the authenticated gateway `/_internal/ready` route. Run a gateway build that supports this route with `GATEWAY_INTERNAL_API=true`; a disabled or unreachable install API stops procurement before signing. This check cannot guarantee that an install will succeed after settlement, so always inspect `receipt.installed`.

## Detect a dApp failure

```ts
import { FailureSpotMonitor } from "@neverdown/sdk";

const monitor = new FailureSpotMonitor();
monitor.register({
  id: "price-api",
  failureThreshold: 2,
  probe: async () => (await fetch("https://prices.example/health")).ok,
  onIncident: async ({ incidentId, reason }) => {
    await switchToApprovedPriceBackup(); // Your app's fast recovery callback
    await replenishPriceBackupUnderPolicy(incidentId, reason); // Your adapter's control plane
  },
  onError: (error) => console.error("price-api recovery failed", error),
});
monitor.start(5000);

// A semantic error that a HTTP probe cannot see:
await monitor.reportFailure("price-api", "price outside expected range");
// When the dependency is healthy again:
monitor.reportHealthy("price-api");
```

`FailureSpotMonitor` observes registered probes and explicit dApp signals. It emits one incident per outage and invokes the app's callback; it does not know that a dApp failed unless the dApp routes a dependency through NeverDown or reports the error. Its state is in memory; use a persistent coordinator for multi-process deployments. The built-in paid procurement adapter remains RPC-specific. Non-RPC backup switching and procurement use the callbacks supplied by the app until adapters are built.

## Console status

```ts
import { getGatewayStatus, evidenceLinks } from "@neverdown/sdk/status";

const { ready, status } = await getGatewayStatus("http://localhost:8787");
console.log(ready.ready, status.active);
console.log(evidenceLinks({ transactionId: "0.0.1@123.456" }).hashscan);
```

The status entry performs read-only GET requests and contains no payment worker import. For a dApp, route a registered dependency through the NeverDown gateway to let its health monitor detect failures. Arbitrary dApp error reporting and non-RPC adapters are future extensions; the SDK cannot observe internal app errors by itself.

## Build and verification

From the repository root:

```bash
pnpm --filter @neverdown/core build
pnpm --filter @neverdown/sdk build
pnpm --filter @neverdown/sdk typecheck
pnpm --filter @neverdown/sdk test
pnpm --filter @neverdown/core test
```

Publishing requires access to the `@neverdown` npm scope. Publish the matching `@neverdown/core` version before `@neverdown/sdk`. The current security boundary is process-level and file permissions, not separate OS users; see `docs/C3-SECURITY-GATE.md` in the repository.

For a release, first run the build, typecheck, and test commands above and inspect `pnpm pack` for both packages. Then, from `packages/core`, run `npm publish --access public`. After registry propagation, run the same command from `packages/sdk`. Keep both package versions aligned, tag the source commit, and verify a clean external install. This repository does not publish as part of its build.
