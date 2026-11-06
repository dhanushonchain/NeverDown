# NeverDown SDK — phased plan

**Implementation status (2026-11-07):** S0–S3 and S4 packaging are implemented in separate commits. `@neverdown/core` and `@neverdown/sdk` build and pack as Node packages; an external consumer installed both tarballs and passed a live read-only ENS → Arkiv → capability check. The packages are **not published to npm**. The SDK also includes an in-process failure spot monitor for dApp probes and explicit error reports. Built-in paid procurement and gateway installation currently support the RPC adapter.

Audience and runtime (locked):

| Decision | Choice | Why |
|---|---|---|
| First user | **Internal** — our gateway / web / agent / scripts | Hardens a real consumer before public npm |
| Runtime | **Node / server only** | Spend keys and payment worker must stay off the browser |
| Base | Facade over existing [`@neverdown/core`](../packages/core) | Do not rewrite C0–C8; wrap the restricted barrel |

Product framing still applies: SDK is a **resilience operator** API. RPC is a demo adapter category, not the product name.

Related: [C3-SECURITY-GATE.md](./C3-SECURITY-GATE.md) · [neverdown-architecture.md](./neverdown-architecture.md) · core barrel [`packages/core/src/index.ts`](../packages/core/src/index.ts)

---

## Non-negotiables

1. **Secrets stay in the payment worker env file** (`PAYMENT_WORKER_ENV_FILE`, mode `0600`). Agent/SDK host must not load `HEDERA_SPEND_KEY`.
2. **Restricted public surface** — do not re-export banned names from core (`payForRpcOnce`, `createHederaX402HttpClient`, `loadBuyerConfig`, raw HCS/budget internals). Keep `security.test.ts` green.
3. **Pay only via `startPaymentWorker` / IPC** — no “convenient” in-process settle helper in the SDK.
4. **Fail closed** — empty ENS allowlist, missing texts, or payTo mismatch → deny before sign.
5. **Build in slices** — each phase has a gate; do not land S2–S4 in one PR.

---

## Target shape (after S2)

```ts
import { NeverDown } from "@neverdown/sdk";

const nd = NeverDown.create({ env: process.env });

// Read-only rails
await nd.resolveSeller({ ensName, expectedPayTo });
await nd.discoverOffers({ category: "rpc", maxPriceTinybars });
await nd.proveCapability({ ... });

// Spend boundary (worker IPC only)
await nd.procure({ incidentId, offer, ... });
```

Browser code may later use a **status-only** entry (S3). It must never receive spend credentials.

---

## Phases

### S0 — Package scaffold (safe re-exports)

**Build**

- Add `packages/sdk` (`@neverdown/sdk`) depending on `@neverdown/core`.
- Re-export only the safe core surface (ENS resolve/validate, `discoverOffers`, PoC, policy load helpers, `startPaymentWorker`, agent types already on the barrel).
- Wire into `pnpm-workspace.yaml` (already includes `packages/*`).
- Smoke: `pnpm --filter @neverdown/sdk typecheck` (or test).

**Gate**

- [x] Package installs in the monorepo
- [x] No banned symbols reachable from `@neverdown/sdk` (mirror/extend `security.test.ts`)
- [ ] Commit message: `feat(sdk): S0 safe re-export package`

---

### S1 — Read-only client

**Build**

- `NeverDown.create({ env })` validates required read env (`ENS_RPC_URL`, `ENS_ALLOWLIST_NAMES`, Arkiv access as needed).
- Methods: `resolveSeller`, `discoverOffers`, `proveCapability`.
- Hermetic unit tests with mocked providers (no live network required).
- Thin script `pnpm sdk:smoke` for local read-only check against the ignored root `.env`.

**Gate**

- [x] Unit tests pass
- [x] Live smoke documented; external tarball consumer passed the live read-only flow
- [ ] Commit: `feat(sdk): S1 read-only NeverDown client`

---

### S2 — Procure via payment worker

**Build**

- `procure(...)` starts or attaches to payment worker; sends purchase request; returns redacted receipt (tx id / HashScan, no keys).
- Deny path covered (allowlist / budget) without settle.
- Do not call deep-imported buyer pay helpers from the SDK.

**Gate**

- [x] Hermetic IPC settle + deny tests pass, including an SDK test through a real compiled worker
- [x] `pnpm --filter @neverdown/core test` still green
- [ ] Commit: `feat(sdk): S2 procure through payment worker`

---

### S3 — Status facade for console

**Build**

- Optional export path for gateway health / evidence link helpers used by `apps/web`.
- No secrets; read-only HTTP to gateway / evidence APIs.

**Gate**

- [x] Console imports `@neverdown/sdk/status` for gateway status
- [ ] Commit: `feat(sdk): S3 status helpers for console`

---

### S4 — Publish-ready package (publication later)

**Build only after S2 is solid**

- Package metadata, LICENSE, README quickstart for integrators.
- Explicit supported Node version; document worker env split.
- Versioning / publish process — not required for ETHGlobal Mumbai demo.

**Gate**

- [x] External tarball consumer runs the read-only README example against testnet with documented env
- [x] Commit: `feat(sdk): S4 publish-ready package docs`

The distribution packages require Node.js 22.13 or newer for `node:sqlite`. `@neverdown/core` must be published before `@neverdown/sdk`; publication requires access to the `@neverdown` npm scope and is a separate external action.

### DApp failure signals (implemented)

`FailureSpotMonitor` registers a service-specific `probe` and accepts explicit `reportFailure(id, reason)` calls for semantic app errors. It emits one incident per outage after a configurable threshold, resets on `reportHealthy`, and invokes an application callback for fast recovery and follow-up procurement. The monitor is in memory; durable coordination and non-RPC procurement adapters remain outside this SDK slice. See `packages/sdk/README.md`.

---

## Out of scope (for now)

- Browser wallet SDK that signs Hedera spends
- Rewriting sellers/gateway into the SDK package
- Claiming production-grade key isolation beyond C3 PARTIAL honesty
- One-shot “full product SDK” PR spanning S0–S4 (the implementation used separate commits)

---

## Suggested order of work

1. Finish demo polish (ENS on-chain texts when funded, video) in parallel if needed — SDK does not block judging.
2. S0 → S3 are implemented in separate commits; run each package's tests when changing the SDK.
3. S4 packaging is ready; publish only after the team controls the npm scope and approves a release.

## Pitch one-liner

> “`@neverdown/sdk` is the server-side Resilience Contract client: discover on Arkiv, verify ENS, prove capability, and procure only through an isolated payment worker — Node only, no Solidity on the Hedera pay path.”
