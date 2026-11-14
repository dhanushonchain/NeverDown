# neverdown-sdk-consumer (example)

**Separate application** that depends only on [`@neverdown/sdk`](../../packages/sdk).  
It is **not** the NeverDown product console (`apps/web`).

**First-time install / 10-minute path:** use [`../minimal-sdk-app`](../minimal-sdk-app) and [docs/SDK-QUICKSTART.md](../../docs/SDK-QUICKSTART.md) (`pnpm sdk:pack`). This consumer is the richer monorepo demo UI.

## Demo UI — without SDK, then with SDK

```bash
pnpm gateway:live          # terminal 1
pnpm sdk-consumer:ui       # terminal 2
```

Open **http://127.0.0.1:3100**

1. **Without SDK** — same outage, hard-coded retries, stays stuck (steps stream live)  
2. **With `@neverdown/sdk`** — detect → ENS → deny → Arkiv → prove → gateway ready  
3. **Live procure + install** — worker IPC → Hedera settle → HashScan → gateway `install-standby` → re-verify  

Each step shows **what it adds**, the **SDK method**, and stays on screen long enough for judges (`DEMO_STEP_MS`, default 1100).

The browser never holds spend keys; the Node UI server imports the SDK.

## CLI

```bash
pnpm sdk-consumer:deny
pnpm sdk-consumer:features
pnpm sdk-consumer:features:procure
pnpm sdk-consumer:procure
pnpm sdk:smoke
```
