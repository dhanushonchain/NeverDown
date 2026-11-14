# NeverDown SDK — quickstart (integrators)

Goal: use `@neverdown/sdk` as the product door without learning the full monorepo.

Node.js **>= 22.13.0**. Packages are **not on npm yet** — install from `pnpm sdk:pack` tarballs.

## Preferred surface

```ts
import { NeverDown, FailureSpotMonitor, assertNeverDownHostEnv } from "@neverdown/sdk";
import { getGatewayStatus } from "@neverdown/sdk/status";
```

Prefer `NeverDown` methods over advanced barrel re-exports (`startPaymentWorker`, free `discoverOffers`, …).

## 10-minute read-only path

1. From the repo root:

```bash
pnpm sdk:pack
cd examples/minimal-sdk-app
pnpm install --ignore-workspace
cp ../../packages/sdk/env.host.example .env.host
```

2. Fill `.env.host` (no spend keys):

- `ENS_RPC_URL` — HTTPS Ethereum RPC (mainnet for `neverdownseller.eth`)
- `ENS_ALLOWLIST_NAMES` — e.g. `neverdownseller.eth`
- `POC_REFERENCE_RPC` — independent Sepolia HTTPS RPC (must differ from candidate)
- `ARKIV_RPC`, `ARKIV_CHAIN_ID`, `ARKIV_ACCESS_KEY`
- `SELLER_ENS_NAME`, `HEDERA_MERCHANT_ACCOUNT_ID` (must match ENS `hederaAccount`)

3. Run:

```bash
pnpm smoke
```

Expected: ENS ok → offer entity key → `Proof ok — read-only smoke passed.`

If env is missing, smoke **skips** with setup hints (exit 0).

Monorepo alternative (uses root `.env` via launcher): `pnpm sdk:smoke`.

## Optional: capped procure

Checklist before `pnpm procure` in the minimal app:

| Check | Why |
|---|---|
| `.env.worker` from `packages/sdk/env.worker.example`, mode `0600` | Spend keys stay out of the SDK process |
| Host `PAYMENT_WORKER_ENV_FILE` points at that file | Worker IPC only |
| `GATEWAY_URL` + `GATEWAY_INTERNAL_TOKEN` (≥20 chars) on host | Install API |
| Gateway running with `GATEWAY_INTERNAL_API=true` | `/_internal/ready` + install-standby |
| Live x402 seller + matching Arkiv v2 offer | Something to buy |
| Policy allowlist / budget / endpoints in worker file | Deny-before-sign |

```bash
pnpm procure
```

### Receipt fields

| Field | Meaning |
|---|---|
| `status: SETTLED` | Hedera payment succeeded |
| `status: DENIED` | Policy refused; nothing signed (see `denyReason`) |
| `status: UNCERTAIN` | Worker transport failure — reconcile before retry |
| `installed` | Gateway accepted standby after settle |
| `hashscanUrl` / `transactionId` | Public evidence when settled |
| `installError` | Settle ok but install failed — do not blindly retry pay |

## Host vs worker (security)

See [`env.host.example`](../packages/sdk/env.host.example) and [`env.worker.example`](../packages/sdk/env.worker.example).

`assertNeverDownHostEnv` / `NeverDown.create` reject spend/operator/Arkiv writer keys in the host process.

## Next reading

- Package API: [packages/sdk/README.md](../packages/sdk/README.md)
- Phase status: [SDK.md](./SDK.md)
- Live evidence: [LIVE-EVIDENCE.md](./LIVE-EVIDENCE.md)
- Rich demo UI: [examples/neverdown-sdk-consumer](../examples/neverdown-sdk-consumer)
