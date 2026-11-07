# Technical audit — repository, frontend, and release readiness

**Audit ref:** `Shadow-Branch`  
**Audit date:** 2026-11-07  
**Scope:** repository architecture, product contracts, web entry points, APIs, build/test configuration, and delivery risks. This is a source/documentation audit, not a claim that every external service was exercised during this task.

## Executive summary

NeverDown is a programmable resilience operator for Web3 applications. A customer defines dependency failure spots and a Resilience Contract (budget, allowlist, permitted actions). The Fast Recovery Plane switches to a preapproved healthy standby without depending on an LLM or payment flow. The Procurement Plane replenishes redundancy by discovering a capability offer, resolving seller identity, testing capability, requesting policy authorization and Hedera x402 settlement, installing the resulting entitlement, and recording evidence.

RPC is the current demonstration adapter, not the product boundary. The system must be described in terms of dependency resilience and capability procurement—not as an RPC monitoring dashboard or a generic AI operations agent.

## Repository layout and technical stack

| Area | Implementation found |
|---|---|
| Workspace | pnpm workspace, pnpm 9.15.0 lockfile; npm workspace compatibility is also configured |
| Runtime | Node.js 22.5+ (built-in `node:sqlite` is used) |
| Shared TypeScript | `packages/core` — policy, x402, HCS, Arkiv, ENS, PoC, agent and incident coordinator |
| Fast Recovery Plane | `apps/gateway` — Express-based JSON-RPC gateway adapter, health probes, active provider, failover and internal install API |
| Demonstration merchant | `apps/sellers` — Express x402 RPC seller, `/probe`, `/rpc-pack`, `/rpc`, bounded entitlements with SQLite or PostgreSQL |
| Frontend | `apps/web` — static HTML/CSS/JS assets served by a TypeScript Node HTTP server; this is not Next.js and does not currently use React/Tailwind for the shipped page |
| Static hosting | `vercel.json` runs `scripts/build-vercel-static.mjs`, copying public files into `dist-vercel`; hosted Vercel output is explicitly a static preview |
| Tests | Node test runner with `tsx`; core, seller, gateway and web packages |
| CI | GitHub Actions has pnpm frozen-lockfile validation plus npm workspace compatibility validation |

## Product flow verified against source

1. **Failure detection:** gateway health controller probes configured providers using JSON-RPC chain ID and block-height checks, request timeouts, failure/recovery thresholds and stale-block tolerance.
2. **Fast recovery:** gateway controller changes the active route to a healthy preconfigured provider; this code path is separate from the agent/payment worker.
3. **Offer discovery:** core Arkiv adapter queries expiring, wallet-owned capability offer entities and filters by category, expiry and price.
4. **Seller identity:** ENS resolver obtains seller records. Procurement compares the seller's Hedera `payTo` and x402 endpoint to the selected Arkiv offer; unresolved or mismatched identities fail closed.
5. **Capability check:** PoC adapter tests candidate RPC chain ID, block freshness, smoke calls, latency and payment recipient relationship before install.
6. **Policy authorization:** PolicyEngine checks seller/payment destination, service, amount and aggregate budget. Denials occur before signing.
7. **Settlement:** x402 buyer path is mediated by the C3 payment worker; its IPC boundary is intended to keep spend keys out of the agent parent environment.
8. **Install:** live agent flow requires a settled purchase and a bounded entitlement before requesting gateway standby installation.
9. **Audit:** HCS authorization/settlement evidence and Hedera transaction evidence are referenced by the receipt/operational documentation; incident summaries/details are persisted through the local evidence API.

## Frontend routes and interactions

The current Node server serves `apps/web/public/index.html` at `/` and `apps/web/public/console.html` at `/console.html`. Other files are served from `public/` with a path traversal/dot-segment guard.

Existing API routes:

| Route | Behavior |
|---|---|
| `GET /api/status` | Reads gateway `/ready` and `/status`; returns 502 if gateway is unavailable |
| `GET /api/evidence` | Returns configured/default ENS, Arkiv, Hedera transaction and HCS topic references; a default reference may belong to a prior run |
| `GET /api/incidents` | Returns incident summaries without receipt contents |
| `GET /api/incidents/:id` | Returns one persisted incident and redacted receipt; ID is validated |
| `POST /api/run-agent` | Runs `procure` or `deny`; defaults to hermetic mode; live execution is controlled by server environment |
| `POST /api/outage` | Proxies to gateway internal install hook only when internal API is enabled |

The console is a five-card flow. It includes interactive previous/next controls, hash-aware act navigation, status refresh, procure/deny scenario controls, evidence loading, and a read-only guide chat. Some Resilience Contract values and narrative copy are demonstrative; changing those display values does not mutate the backend policy. The hosted static preview does not call local API routes and disables backend-only interactions. The local evidence endpoint returns only explicitly configured identifiers; absent references are null rather than stale sample IDs.

## Existing limitations / claims boundary

- C3 payment-worker separation is documented as **PARTIAL**. The root environment/SQLite files remain accessible to processes under the same OS user; file-based credentials are not a vault or KMS.
- C8 hermetic flow has tests. The latest live evidence document records a configured RPC-demo purchase and install, but the C3/C8 security handoff still warns that the full agent-to-worker live path and OS-enforced isolation are not fully accepted. Avoid describing this as complete security isolation.
- The latest live evidence records procurement/standby install while the primary stayed healthy. It explicitly says a live primary outage was not induced; failover is supported by hermetic gateway tests.
- The ENS setup guide requires genuine on-chain seller text records before treating ENS evidence as final; local overlay is rehearsal-only.
- `/api/evidence` has fallback identifiers and says they may be from a previous run. Never imply these values were freshly fetched or are proof of the visitor's current session.
- `apps/web` is a local backend UI. Vercel static output is a preview, not a deployed live backend.
- The audit does not constitute an independent live payment, Arkiv write, ENS text-record update, or HCS verification.

## Build and validation surface

Root scripts include workspace build, typecheck, lint, unit tests, web tests and web smoke test. Canonical reproducible install is `pnpm install --frozen-lockfile`. CI also tests the npm workspace path (`npm install`, typecheck, build, test). The Vercel static export is a separate build path (`node scripts/build-vercel-static.mjs`).

GitHub Actions on the fork previously completed both package-manager jobs successfully for commit `5957a89ee2f8458d0417f27605043c2cc15f94f8`: pnpm frozen install/typecheck/build/core-seller-gateway tests/web tests/smoke, and npm install/typecheck/build/tests. This historical run must not be confused with the new Phase 3 branch's run; new checks will be recorded separately.

## Bugs and risks identified during audit

1. Root README and app docs previously described aspects of the current static frontend inconsistently; the public product page must accurately distinguish a static preview from the local backend console.
2. Evidence fallback IDs can be stale; landing-page labels must say “example / recorded evidence” where applicable rather than “live now”.
3. Visual Resilience Contract values in the console are illustrative rather than editable backend policy.
4. The local console server is bound to loopback, as intended for the local operator UI; it must not be represented as an internet-facing hosted operations dashboard.
5. The security gate and live runbook document residual worker file-access risk and incomplete ENS on-chain text-record publication. These are acceptance items, not things a UI change can close.

## Landing-page implementation plan

- Preserve `/console.html` and every API/backend implementation.
- Keep `/` as a short marketing landing page, while retaining a clear “Open local console” entry to `/console.html`.
- Build a simple explanatory architecture visual using lightweight inline SVG/CSS, not a fake live dashboard.
- Explain fast recovery separately from procurement and make the policy gate visible.
- Explain Hedera, Arkiv and ENS in the context of NeverDown's flow.
- Use only repository-owned/known links: README, architecture, live evidence, security gate, GitHub repository, and the existing console route.
- Respect reduced motion, responsive layouts, keyboard operation, theme preference, and avoid unverified live-status badges.

## Phase 3 release gates

- Install with frozen pnpm lockfile.
- Run package typecheck, lint, build, core/seller/gateway/web tests, and web smoke checks.
- Run separate static Vercel export build.
- Inspect server and console API compatibility and route preservation.
- Check landing-page links, local routes, keyboard navigation, reduced motion and responsive breakpoints by code-level checks; record browser checks as unrun if no browser is available.
- Review changed paths/diff, ensure no env files/secrets/generated DB/build artifacts are committed, and verify branch/PR ancestry.
- Perform live external acceptance only with configured owner credentials and services; do not run live spend commands without user-provided credentials and an explicitly safe test plan.
