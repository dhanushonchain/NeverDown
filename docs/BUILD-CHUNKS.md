# NeverDown — chunked build guide (C0 → C10)

**Rule:** build one chunk, pass its gate, commit, then start the next.  
Do **not** start UI (C9) before rails (C1–C7) and agent (C8) work.

**Agents / new chat context:** [../AGENTS.md](../AGENTS.md) · [AGENT-CONTEXT.md](./AGENT-CONTEXT.md)  
(RPC is a **demo vertical**, not the product — see AGENT-CONTEXT before coding.)

| Diagrams | [neverdown-architecture.md](./neverdown-architecture.md) · [neverdown-architecture.excalidraw](./neverdown-architecture.excalidraw) |
| Product README | [../README.md](../README.md) |

---

## Progress

| Chunk | Name | Status | Gate |
|---|---|---|---|
| C0 | Monorepo scaffold | **Done** | `pnpm install` |
| C1 | x402 seller (402 only) | **Done + tested** | unpaid `POST /rpc` → HTTP 402 |
| C2 | Hedera pay roundtrip | **Done + live HashScan settle** | `pnpm pay:once` → HashScan tx id |
| C3 | PolicyEngine + HCS | **Code done + tested** (security **PARTIAL** — [C3-SECURITY-GATE.md](./C3-SECURITY-GATE.md)) | Deny + PAY logged; worker IPC |
| C4 | Gateway fast plane | **Code landed** (merged) | Failover without AI |
| C5 | Arkiv offers | **Code done** (live needs `ARKIV_*`) | Live query returns offers |
| C6 | ENSv2 resolve identity | **Code done** (hermetic tests) | Off-allowlist fail-closed |
| C7 | Proof-of-Capability | **Done** | Bad RPC rejected |
| C8 | Supreme Agent wire-up | **Done** | Act 3 + Act 4 CLI |
| C9 | Console UI | **Done** | `pnpm web:dev` + five acts |
| C10 | Judge packaging | **Baseline** (video still operator-recorded) | Checklist in this chunk + LIVE-EVIDENCE |

---

## C0 — Monorepo scaffold (done)

### Goal

Empty but installable pnpm workspace named **NeverDown**. No feature code yet.

### What exists

```
neverdown/
  apps/web/          # placeholder → C9
  apps/gateway/      # placeholder → C4
  apps/sellers/      # placeholder → C1
  packages/core/     # placeholder → C2–C8
  docs/              # architecture + this guide
  arkiv/             # judge md files → C5 / C10
  .env.example
  LICENSE (MIT)
  package.json + pnpm-workspace.yaml
```

### Steps (already completed)

1. Create root `package.json` (`name: neverdown`) and `pnpm-workspace.yaml`.
2. Add `tsconfig.base.json`, `.gitignore`, `.env.example`, `LICENSE`.
3. Add empty package shells for `web`, `gateway`, `sellers`, `core`.
4. Export placeholder `neverdownIdentity()` from `@neverdown/core`.

### Gate

```bash
# Windows: if pnpm not on PATH
npx pnpm@9.15.0 install
npx pnpm@9.15.0 -r list --depth -1
```

Expect all five workspace packages listed.

### Done when

- [x] `pnpm install` succeeds  
- [x] No feature logic beyond placeholders  
- [x] Brand is NeverDown everywhere in repo docs  

---

## C1 — x402 seller returns HTTP 402

### Goal

A real merchant endpoint that quotes a price with Hedera x402 `PaymentRequirements` and returns **402 Payment Required** — without accepting payment yet.

### Why first

Hedera track requires an x402-protected endpoint. Prove the merchant side before the agent pays.

### Build only

`apps/sellers/**`

### Detailed steps

1. Add runtime deps: Hono (or Express), `@x402/hedera` server helpers if available, dotenv.
2. Implement `GET` or `POST /v1/rpc-pack`:
   - If no valid payment header → respond **402** with JSON body containing:
     - `scheme: "exact"`
     - `network: "hedera:testnet"`
     - `amount` (tinybars)
     - `asset: "0.0.0"` (HBAR) or HTS id
     - `payTo` = `SELLER_PAY_TO` from env
     - `extra.feePayer` = facilitator fee payer from docs
   - Do **not** settle yet; return 402 always in C1.
3. Add health `GET /health` → `{ ok: true, service: "neverdown-sellers" }`.
4. Document env vars in sellers README: `SELLER_PORT`, `SELLER_PAY_TO`, facilitator fee payer.

### Gate

```bash
pnpm --filter @neverdown/sellers dev
curl -i http://localhost:8788/v1/rpc-pack
```

Expect: `HTTP/1.1 402` and a JSON body with Hedera exact fields.

### Done when

- [ ] 402 response matches Hedera exact scheme shape  
- [ ] No private keys in sellers process for C1  
- [ ] Commit: `feat(sellers): C1 x402 402 quote endpoint`  

### Does not include

Paying, PolicyEngine, Arkiv, UI.

---

## C2 — Hedera pay roundtrip

### Goal

Script pays the C1 merchant end-to-end on **Hedera testnet** via facilitator. No human approve click.

### Implemented

- `@neverdown/core` `src/x402/` — `loadBuyerConfig`, `createHederaX402HttpClient`, `payForRpcOnce`
- `scripts/pay-once.ts` + root `pnpm pay:once`
- Hermetic tests with mocked fetch
- Docs: [C2-PAY-ONCE.md](./C2-PAY-ONCE.md)

### Gate

```bash
pnpm --filter @neverdown/sellers dev   # terminal A
pnpm pay:once                          # terminal B — needs HEDERA_SPEND_ID + HEDERA_SPEND_KEY
# → transactionId + https://hashscan.io/testnet/transaction/...
```

### Done when

- [x] Buyer code + hermetic tests  
- [ ] Live settled testnet payment (fill spend env + faucet)  
- [x] No human approval in the script path  
- [ ] Commit: `feat(core): C2 hedera x402 pay-once`  

---

## C3 — PolicyEngine + HCS audit

### Goal

All spends go through PolicyEngine. Allowlist + budget enforced. Every PAY/DENY written to an HCS topic.

### Why

Extra points on Hedera (budgets, allowlists, HCS audit) and the Act 4 deny demo.

### Build only

`packages/core/src/policy/**`, `packages/core/src/hcs/**`, `scripts/policy-smoke.ts`

### Detailed steps

1. Create HCS topic (operator key); store `HEDERA_TOPIC_ID`.
2. Policy state: `{ capTinybars, spentTinybars, allowlist: string[], policyVersion }`.
3. `authorizePurchase({ sellerId, payTo, amountTinybars })`:
   - Deny if seller not in allowlist → HCS `DENY` `{ reason: OFF_ALLOWLIST }`  
   - Deny if `spent + amount > cap` → `OVER_CAP`  
   - Deny if `payTo` mismatches expected → `PAYTO_MISMATCH`  
   - Else call x402 pay (C2), then HCS `PAY`, increment spent  
4. Spend private key **only** inside PolicyEngine module — never log it, never pass to LLM.
5. Smoke script: good purchase, over-cap, bad seller.

### Gate

```bash
pnpm exec tsx scripts/policy-smoke.ts
# good → PAY on Mirror topic
# bad  → DENY, no HashScan settle for that attempt
```

Verify Mirror: `GET /api/v1/topics/{id}/messages`

### Done when

- [ ] Deny path never signs  
- [ ] PAY and DENY both visible on topic  
- [ ] Unit/smoke covers three deny reasons  
- [ ] Commit: `feat(core): C3 policy engine and HCS audit`  

---

## C4 — Gateway fast recovery plane

### Goal

Deterministic **fast-plane adapter** (hackathon demo: JSON-RPC proxy): health-check primary, switch to preapproved standby **without** LLM or x402. RPC is an **example failure spot**, not the product boundary.

### Why

Proves “recovery before procurement.” Data plane must survive control-plane outage. Same pattern later wraps other dependency types under one Resilience Contract.

### Build only

`apps/gateway/**`

### Detailed steps

1. Config: `GATEWAY_PRIMARY_RPC`, `GATEWAY_STANDBY_RPC`, poll interval, stale-block threshold.
2. Health probes every N seconds:
   - TCP/HTTP reachable  
   - `eth_chainId` matches expected  
   - `eth_blockNumber` not stale vs independent probe (or vs last good)  
3. Proxy JSON-RPC to **active** upstream.
4. On primary fail → flip to standby; keep `rollback` = previous primary.
5. Admin endpoints (local only): `GET /status`, `POST /inject-outage` (demo), `POST /restore-primary`.
6. Test: stop primary process → client still gets blocks via standby within seconds.

### Gate

```bash
# terminal A
pnpm --filter @neverdown/gateway dev
# terminal B — kill primary / inject outage
curl http://localhost:8787/status   # active=standby
curl -X POST http://localhost:8787/rpc -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

### Done when

- [ ] Failover works with agent process **stopped**  
- [ ] Status shows primary vs standby  
- [ ] Commit: `feat(gateway): C4 fast recovery failover`  

---

## C5 — Arkiv capability offers

### Goal

Wallet-owned, expiring **Offer** entities on Arkiv. Agent (later) queries them; for C5 a CLI query is enough.

### Why

Arkiv “Build from scratch” — write + **read** must affect product behavior.

### Build only

`packages/core/src/arkiv/**`, `scripts/seed-arkiv.ts`, start `arkiv/schema.md`

### Detailed steps

1. Get Arkiv access key + fund wallet (Rabdi testnet, chain id `7794095`).
2. Define entity attributes (lowercase names only):
   - `sellerens`, `serviceurl`, `pricetinybars`, `chainid`, `category`, `payto`, `expiresat`
3. Seed three offers: good A, good B, expired or malicious C.
4. `discoverOffers({ category, maxPrice })` filters non-expired.
5. Draft `/arkiv/schema.md` (fields, owner, expiry). Leave reach/friction/why for C10 polish.

### Gate

```bash
pnpm exec tsx scripts/seed-arkiv.ts
pnpm exec tsx scripts/query-arkiv.ts
# prints ≥1 live offer with entity key
```

### Done when

- [x] Entities visible on Arkiv explorer (after `pnpm arkiv:seed` with funded key)  
- [x] Expired offer excluded from query (short-lived seed + protocol `$expiresAt`)  
- [x] Writer wallet address printed by seed script / noted in docs  
- [x] Commit: `feat(arkiv): C5 seed and query capability offers`  

---

## C6 — ENSv2 seller identity

### Goal

Allowlist is ENS names. Resolve live on Sepolia/mainnet ENSv2; text records supply Hedera `payTo` / service URL. Fail closed.

### Why

ENS track: identity must be **central**, not cosmetic labels.

### Build only

`packages/core/src/ens/**`, `scripts/seed-ens.ts` (or document manual name setup)

### Detailed steps

1. Register/use parent + subnames for sellers A/B and a malicious C (Sepolia OK).
2. Set text records: `hederaAccount`, `x402Url`, `arkivOwner`, `category`.
3. `resolveSeller(name)` → records or throw.
4. Policy allowlist stores ENS names; before pay, resolve and match `payTo`.
5. Off-allowlist or resolve failure → DENY (reuse C3).

### Gate

```bash
pnpm exec tsx scripts/ens-smoke.ts
# allowlisted name → records
# unknown name → error / deny
```

### Done when

- [ ] No hardcoded name→address map in hot path  
- [ ] Mismatch `payTo` vs ENS record denied  
- [ ] Commit: `feat(ens): C6 ENSv2 resolve allowlist`  

---

## C7 — Proof-of-Capability

### Goal

Before install, verify an RPC candidate is actually usable **now**.

### Build only

`packages/core/src/poc/**`, `scripts/poc-smoke.ts`

### Detailed steps

Implement `proofOfCapability(rpcUrl, { expectedChainId, payTo, ensPayTo })`:

1. `eth_chainId` == expected  
2. Block number within freshness window vs independent RPC  
3. `eth_getBlockByNumber` / `eth_call` smoke  
4. Latency under threshold  
5. `payTo` matches ENS record  
6. Return `{ pass, checks[] }`  

### Gate

```bash
pnpm exec tsx scripts/poc-smoke.ts
# good RPC → pass
# wrong chainId / stale → fail
```

### Done when

- [x] Failures never install standby  
- [x] Checks listed in evidence object  
- [x] Commit: `feat(core): C7 proof-of-capability`  

---

## C8 — Supreme Agent (wire C3–C7)

### Goal

One tool-calling agent that runs Act 3 (procure) and Act 4 (deny) from CLI — still no fancy UI.

### Build only

`packages/core/src/agent/**`, `scripts/agent-demo.ts`

### Tools (only these)

| Tool | Calls |
|---|---|
| `discover_offers` | C5 Arkiv |
| `resolve_seller` | C6 ENS |
| `proof_of_capability` | C7 |
| `request_purchase` | C3 Policy → x402 |
| `install_standby` | C4 gateway admin API |
| `force_bad_purchase` | demo deny |

### Detailed steps

1. Use Vercel AI SDK / OpenAI tool loop with small system prompt: stay inside policy; prefer cheapest valid offer.
2. Scenario A: primary already failed (or standby-only) → discover → ENS → PoC → purchase → install.
3. Scenario B: force bad seller / over cap → DENY on HCS.
4. Print evidence receipt JSON to stdout.

### Gate

```bash
pnpm exec tsx scripts/agent-demo.ts --scenario procure
pnpm exec tsx scripts/agent-demo.ts --scenario deny
```

### Done when

- [x] Procure path updates gateway standby (hermetic record + live admin API / gateway `installStandby`)  
- [x] Deny path has no settle  
- [x] Commit: `feat(agent): C8 supreme agent procure and deny`  

---

## C9 — Console UI (five-act demo)

### Goal

Next.js console so judges click through the five acts without CLI.

### Build only

`apps/web/**` (+ thin API routes calling `@neverdown/core` / gateway)

### Screens

1. **Resilience Contract** — cap, remaining, ENS allowlist, objective  
2. **Dependency graph** — simple manifest visualization  
3. **Live status** — gateway primary/standby health  
4. **Incident timeline** — detect → switch → procure → verify  
5. **Evidence** — HashScan, Arkiv entity, ENS name, HCS sequence  

### Controls

- Inject primary outage  
- Run procure  
- Run deny attack  
- Copy proof links  

### Gate

Local demo: complete acts 1–5 in under 90 seconds without opening a terminal.

### Done when

- [x] Five-act path works on a clean machine with root `.env`
- [x] Commit: `feat(web): C9 neverdown console five-act demo`  

---

## C10 — Judge packaging

### Goal

Submission-ready README + Arkiv judge files + video checklist.

### Files to complete

| File | Purpose |
|---|---|
| `README.md` | Setup, architecture, payment flow, **settled tx id**, Arkiv query, ENS names, AI usage, MIT |
| `arkiv/schema.md` | Entities, fields, owners, expiry |
| `arkiv/friction.md` | What broke / what Arkiv should improve |
| `arkiv/reach.md` | Who it’s for |
| `arkiv/why-arkiv.md` | Why not Postgres |
| `arkiv/how-you-use-arkiv.md` | Filters, ownership, expiry → user-visible |
| `docs/DEMO-SCRIPT.md` | 90s + 5 min video beats |

### Hedera README must include

- Setup steps  
- Architecture summary  
- Payment flow  
- At least one **Hedera transaction ID** + HashScan link  

### Gate (ship checklist)

- [ ] Autonomous x402 settle documented  
- [ ] Agent purchase without human approve  
- [ ] Fast failover without LLM  
- [ ] Arkiv write+read drives offer choice  
- [ ] ENSv2 live resolve gates payment  
- [ ] HCS PAY and DENY visible  
- [ ] Control plane down → gateway still serves  
- [ ] Video ≤5 min planned/recorded  
- [ ] Public repo under **ujjwaldubey1**  

### Done when

All boxes checked; tag `v0.1.0-demo`.

---

## Parallelism (optional)

After **C0**:

- C4 can proceed in parallel with C1–C3  
- After **C3**: C5 and C6 can proceed in parallel  
- C7 needs C4 (RPC URLs) ideally  
- C8 needs C3–C7  
- C9 needs C8  
- C10 last  

---

## Env reference

See [../.env.example](../.env.example). Fill before C1/C2; never commit `.env`.
