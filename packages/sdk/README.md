# @neverdown/sdk

Server-side client for NeverDown's programmable resilience operator. The current procurement adapter handles RPC failure spots on Ethereum Sepolia, with ENS seller identity, Arkiv offers, independent capability proof, Hedera testnet x402 payment, and a gateway standby install.

Requires Node.js 22.13 or newer because the payment ledger uses Node's built-in SQLite module. The SDK does not run a Hedera spending wallet in a browser. The status-only `@neverdown/sdk/status` entry has no signing imports.

**Integrators:** start at [docs/SDK-QUICKSTART.md](../../docs/SDK-QUICKSTART.md) and [examples/minimal-sdk-app](../../examples/minimal-sdk-app).

## Preferred API

Use these in application code:

| Export | Role |
|---|---|
| `NeverDown.create` / `discoverOffers` / `resolveSeller` / `proveCapability` / `procure` | Resilience Contract client |
| `FailureSpotMonitor` | In-process failure detection + callbacks |
| `assertNeverDownHostEnv` | Validate host env (also used by `create`) |
| `@neverdown/sdk/status` | Read-only gateway / HashScan helpers |

Raw re-exports such as `startPaymentWorker` and free-standing `discoverOffers` are **advanced escape hatches** for tests and custom wiring. Prefer the `NeverDown` class methods.

## Install (not on npm yet)

From the NeverDown repo root:

```bash
pnpm sdk:pack
cd examples/minimal-sdk-app
pnpm install
```

Or install the tarballs into any Node project:

```bash
npm install ./neverdown-core-0.1.0.tgz ./neverdown-sdk-0.1.0.tgz
```

Tarballs land in `dist/sdk-packs/` and `examples/minimal-sdk-app/packs/`.

After an npm release:

```bash
npm install @neverdown/sdk
```

Publish `@neverdown/core` before `@neverdown/sdk`. For a monorepo checkout, `pnpm install` at the repository root links workspace packages.

## Host env vs worker file

NeverDown splits secrets on purpose:

| Location | File | Contents |
|---|---|---|
| **Host** (SDK process) | [`env.host.example`](./env.host.example) | `ENS_*`, `POC_REFERENCE_RPC`, `ARKIV_*` (read), `GATEWAY_*`, path to worker file |
| **Worker** (mode `0600`) | [`env.worker.example`](./env.worker.example) | `HEDERA_SPEND_*`, operator keys, policy budget/allowlist, `POLICY_DB_PATH` |

`NeverDown.create` **rejects** `HEDERA_SPEND_KEY`, `HEDERA_OPERATOR_KEY`, `ARKIV_PRIVATE_KEY`, and `RECLAIM_PRIVATE_KEY` in the host env. Point `PAYMENT_WORKER_ENV_FILE` at the worker file; only the payment worker reads it.

The monorepo root [`.env.example`](../../.env.example) still documents the full local stack. Integrators should use the two SDK examples above instead of loading spend keys into the app process.

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

Set `ENS_RPC_URL` (HTTPS), non-empty `ENS_ALLOWLIST_NAMES`, `POC_REFERENCE_RPC`, and Arkiv read vars. Run `pnpm smoke` in `examples/minimal-sdk-app` or `pnpm sdk:smoke` from the monorepo.

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

Before `procure`: worker file + `GATEWAY_URL` + `GATEWAY_INTERNAL_TOKEN` (≥20 chars) on the host; gateway with `GATEWAY_INTERNAL_API=true`. Receipt statuses: `SETTLED` | `DENIED` | `RELEASED` | `UNCERTAIN`. Always inspect `installed` after a settle. Use a stable `incidentId` to avoid duplicate purchases. Only `category: "rpc"` is supported today.

## Detect a dApp failure

```ts
import { FailureSpotMonitor } from "@neverdown/sdk";

const monitor = new FailureSpotMonitor();
monitor.register({
  id: "price-api",
  failureThreshold: 2,
  probe: async () => (await fetch("https://prices.example/health")).ok,
  onIncident: async ({ incidentId, reason }) => {
    await switchToApprovedPriceBackup();
    await replenishPriceBackupUnderPolicy(incidentId, reason);
  },
  onError: (error) => console.error("price-api recovery failed", error),
});
monitor.start(5000);
```

Paid procurement remains RPC-specific; non-RPC spots use your callbacks until adapters exist.

## Console status

```ts
import { getGatewayStatus, evidenceLinks } from "@neverdown/sdk/status";

const { ready, status } = await getGatewayStatus("http://localhost:8787");
console.log(ready.ready, status.active);
console.log(evidenceLinks({ transactionId: "0.0.1@123.456" }).hashscan);
```

## Build and verification

```bash
pnpm sdk:pack
pnpm --filter @neverdown/sdk test
pnpm --filter @neverdown/core test
```

Security boundary is process-level + file permissions (PARTIAL); see `docs/C3-SECURITY-GATE.md`.
