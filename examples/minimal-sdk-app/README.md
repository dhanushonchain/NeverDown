# Minimal `@neverdown/sdk` app

Stranger-facing integrator example. Installs **only** from packed tarballs — you do not need to understand `apps/web` or the rest of the monorepo.

Node.js **>= 22.13.0** required.

## 1. Pack the SDK (from repo root)

```bash
pnpm sdk:pack
```

This writes `packs/neverdown-core-0.1.0.tgz` and `packs/neverdown-sdk-0.1.0.tgz` into this folder (and `dist/sdk-packs/`).

## 2. Install

```bash
cd examples/minimal-sdk-app
pnpm install --ignore-workspace
# or: npm install
```

This folder sets `ignore-workspace=true` so pnpm does not join the monorepo and installs from `packs/*.tgz` only.

Equivalent manual install:

```bash
npm install ./packs/neverdown-core-0.1.0.tgz ./packs/neverdown-sdk-0.1.0.tgz
```

## 3. Host env (no spend keys)

```bash
cp ../../packages/sdk/env.host.example .env.host
# edit: ENS_RPC_URL, ENS_ALLOWLIST_NAMES, POC_REFERENCE_RPC, ARKIV_*, SELLER_ENS_NAME, HEDERA_MERCHANT_ACCOUNT_ID
```

Never put `HEDERA_SPEND_KEY` or `HEDERA_OPERATOR_KEY` in `.env.host`. `NeverDown.create` rejects them.

## 4. Read-only smoke (~10 minutes)

```bash
pnpm smoke
```

Runs: resolve ENS → discover Arkiv offers → proof-of-capability. No payment.

If host env is missing, the script **skips** with setup hints (exit 0).

## 5. Optional: capped procure

1. Copy `../../packages/sdk/env.worker.example` → `.env.worker`, fill keys, `chmod 600 .env.worker` (Unix).
2. Set `PAYMENT_WORKER_ENV_FILE=./.env.worker` in `.env.host`.
3. Run a NeverDown gateway with `GATEWAY_INTERNAL_API=true` and matching `GATEWAY_INTERNAL_TOKEN` (≥20 chars).
4. Seller + Arkiv offer must be live.

```bash
pnpm procure
```

Receipt statuses: `SETTLED` | `DENIED` | `RELEASED` | `UNCERTAIN`. Always check `installed` after a settle.

## Preferred API

```ts
import { NeverDown } from "@neverdown/sdk";

const nd = NeverDown.create({ env: process.env });
await nd.discoverOffers({ category: "rpc", maxPriceTinybars: 10000n });
await nd.procure({ incidentId, serviceId, offer });
```

Full guide: [docs/SDK-QUICKSTART.md](../../docs/SDK-QUICKSTART.md)

For a richer judge demo UI, see [../neverdown-sdk-consumer](../neverdown-sdk-consumer).
