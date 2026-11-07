# Local development and manual demo

## Requirements
- Node.js 22.5+ (Node 22 LTS recommended).
- pnpm 9.15.0 (canonical workspace manager).

## A. Homepage and console only — 1 terminal
From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm web:dev
```

Open http://localhost:3000 and http://localhost:3000/console.html. This starts the website only, not the gateway or seller.

## B. Local full-stack mock demo — 5 terminals, no keys

One-time setup:

```bash
pnpm install --frozen-lockfile
pnpm demo:local:setup
```

This creates an ignored `.env.demo.local` with mock-only values. The demo launcher reads only this file, not your real `.env`, and does not pass signing keys to child processes.

Start five terminals from the repository root:

| Terminal | Command | Purpose |
|---|---|---|
| 1 | `pnpm demo:local:rpc:primary` | Local mock primary RPC on 8788 |
| 2 | `pnpm demo:local:rpc:standby` | Local mock standby RPC on 8789 |
| 3 | `pnpm demo:local:gateway` | Fast Recovery gateway on 8787 |
| 4 | `pnpm demo:local:seller` | Mock x402 seller on 4001 |
| 5 | `pnpm demo:local:web` | Homepage, console and local API on 3000 |

Then run this short-lived readiness check:

```bash
pnpm demo:ready
```

Open http://localhost:3000 and http://localhost:3000/console.html.

**Demo boundary:** the services are real local processes, but the RPC servers are mocks. The seller uses `RPC_MODE=mock`. The hermetic agent simulates Arkiv, ENS, PoC and purchases. Its simulated transaction ID is not a Hedera transaction, and this local setup cannot settle x402 or write to Arkiv/ENS/HCS.

Stop each long-running service with Ctrl+C. Clean up the demo-only profile and SQLite files with:

```bash
pnpm demo:local:reset
```

## C. Hermetic agent/PoC checks — no service terminals

```bash
pnpm agent:demo -- --scenario procure
pnpm agent:demo -- --scenario deny
pnpm poc:smoke
```

These are deterministic logic demonstrations, not live chain operations.

## D. Live testnet integration — 3 required service terminals (+ optional coordinator)

Live mode requires your own funded Hedera testnet account, Hedera operator/spend credentials, Arkiv access and writer credentials, real ENS seller records, an independent Sepolia reference RPC, a seller with a real Sepolia upstream, and two independent Sepolia gateway providers. Live procurement can spend testnet HBAR.

Copy and edit the ignored root environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Fill values locally. Never paste private keys into chat or commit `.env`.

Run independent read-only ENS and Arkiv checks first:

```bash
pnpm ens:check
pnpm arkiv:query
```

Stop if either check fails. Do not relax the allowlist or identity checks.

Start services:

| Terminal | Command |
|---|---|
| 1 | `pnpm gateway:live` |
| 2 | `pnpm seller:live` |
| 3 | `pnpm web:dev` |
| 4 (optional) | `pnpm coordinator:live` |

With the seller and gateway listening, run the complete read-only preflight from another terminal:

```bash
pnpm preflight:live
```

This step checks the configured seller's unpaid x402 challenge and gateway readiness, so it cannot pass until those services are running. Stop if it fails. Only after it passes, use another terminal for the live agent:

```bash
pnpm agent:live
pnpm agent:deny-live
```

The procure run may spend the configured testnet amount. The deny run should return `RECIPIENT_NOT_ALLOWLISTED` with no settlement. Verify the new HashScan transaction, the HCS Mirror Node record, and gateway `/status`. A live primary outage must be induced separately to claim live failover; the existing evidence does not claim that a live outage was induced.

## E. Build and checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:smoke
pnpm build
node scripts/build-vercel-static.mjs
```

Vercel output is a static preview, not a deployed live backend.

## Terminal count
- Homepage/console only: **1 terminal**.
- Local full-stack mock demo: **5 long-running terminals**.
- Live integrations: **3 required service terminals**, **4 with coordinator**, plus short-lived preflight/agent commands.
