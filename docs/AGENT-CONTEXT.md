# NeverDown — agent / teammate context

Read this if you (or your coding agent) previously assumed NeverDown is an **RPC-only** pay/failover app. That context is **outdated**.

Repo: [github.com/dhanushonchain/NeverDown](https://github.com/dhanushonchain/NeverDown)  
Product README: [../README.md](../README.md) · Chunks: [BUILD-CHUNKS.md](./BUILD-CHUNKS.md) · Architecture: [neverdown-architecture.md](./neverdown-architecture.md)

---

## What NeverDown is

**Programmable application resilience** for Web3 ops:

1. Register **failure spots** (any critical dependency).
2. Encode **what to do** (budget, allowlist, allowed actions) in a **Resilience Contract** / PolicyEngine.
3. **Fast plane:** switch to a preapproved standby (no LLM, no payment).
4. **Procurement plane:** discover → identity → capability proof → policy → pay → install.
5. **Prove** decisions (Hedera x402 settle + HCS audit + HashScan).

**RPC is the demo vertical** (C1 seller, C2 buyer, C4 gateway speak JSON-RPC). Same pattern applies to indexer / price API / etc. later. Prefer language: *failure spot*, *capability*, *category* (e.g. `rpc`).

It is **not** a chatbot that SSHes into prod.  
It is **not** “Stripe for RPC” as the end product.

---

## End-to-end flow

```text
Failure spot unhealthy
  → Fast plane: preapproved standby? (C4 demo = RPC gateway)
  → App keeps serving
  → Procurement:
       Arkiv discoverOffers (C5)
       → ENS allowlist resolve (C6 — next)
       → Proof-of-Capability (C7)
       → PolicyEngine authorize (C3)  [deny = no sign + HCS DENY]
       → Hedera x402 pay vs seller 402 (C2 / C1)
       → Install standby + HCS PAY
```

---

## Chunk status (source of truth: BUILD-CHUNKS)

| Chunk | Status | Location / commands |
|---|---|---|
| C0 | **Done** | Monorepo scaffold |
| C1 | **Done + tested** | `apps/sellers` — unpaid `/rpc` → 402 |
| C2 | **Done + live HashScan** | `packages/core/src/x402` — `pnpm pay:once` |
| C3 | **Done + tested** (security gate **PARTIAL**) | `packages/core/src/policy`, `hcs`, `payment-worker` — `pnpm policy:smoke` · see [C3-SECURITY-GATE.md](./C3-SECURITY-GATE.md) |
| C4 | **Code + hermetic tests** | `apps/gateway` — failover without AI |
| C5 | **Code done** (live needs `ARKIV_*`) | `packages/core/src/arkiv` — `pnpm arkiv:seed` / `arkiv:query` |
| C6 | **Code done** (hermetic) | `packages/core/src/ens` — resolve allowlist, fail closed |
| C7 | **Done** | `packages/core/src/poc` — `pnpm poc:smoke` |
| C8 | **Done** | `packages/core/src/agent` — `pnpm agent:demo` / `agent:live` |
| C9 | **Done** | `apps/web` — `pnpm web:dev` five-act console |
| C10 | **Baseline** | Evidence + Arkiv judge md + demo/video checklists |

---

## Prize rails (do not invent alternatives)

| Rail | Role |
|---|---|
| **Hedera x402 + HCS** | Pay + audit (`cryptoTransfer` / exact; no Solidity on this path) |
| **Arkiv** | Expiring wallet-owned **offers** the agent queries |
| **ENS** | Seller/agent **identity** on the allowlist (central, not cosmetic) |

---

## Next phase: ship polish

- Publish real ENS text records on `neverdownseller.eth` / `neverdown.eth` (disable `ENS_ALLOW_TEXT_OVERLAY`) — [ENS-SETUP.md](./ENS-SETUP.md)
- Record ≤5 min video from [DEMO-SCRIPT.md](./DEMO-SCRIPT.md) / [VIDEO-CHECKLIST.md](./VIDEO-CHECKLIST.md)
- Keep live evidence current: [LIVE-EVIDENCE.md](./LIVE-EVIDENCE.md)
- SDK (phased, internal Node facade): [SDK.md](./SDK.md) — start at S0, do not one-shot S0–S4

---

## Monorepo map

```text
apps/sellers/     C1 x402 merchant (RPC demo)
apps/gateway/     C4 fast plane (RPC demo adapter)
apps/web/         C9 placeholder
packages/core/    C2–C8 shared: x402, policy, hcs, arkiv, (ens…)
scripts/          pay-once, policy-smoke, arkiv seed/query, …
arkiv/            Judge markdown (schema.md started in C5)
docs/             Architecture, chunks, per-chunk guides
```

---

## Working rules for agents

1. `git pull` before work; one chunk per effort; pass the chunk gate.
2. Prefer Plan → implement for multi-file chunks.
3. Never commit secrets; never log private keys.
4. Keep RPC demos working while generalizing names/docs.
5. Push only when the human asks.
6. Older chat history that says “build an RPC autopay product” is **wrong** — follow this file + README.
7. Before changing pay/policy/HCS/worker/C8 live purchase: read [C3-SECURITY-GATE.md](./C3-SECURITY-GATE.md) (BigInt hash fix, restricted barrel, PARTIAL isolation, C8 live gap).
