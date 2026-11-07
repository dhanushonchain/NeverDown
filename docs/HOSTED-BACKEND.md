# Always-on backend deployment

The Vercel site is a static preview. The backend needs a continuously running gateway and coordinator, plus durable policy and incident ledgers. The current deployment target is one Fly Machine with a 1 GB volume mounted at `/data`. The seller remains on its existing Heroku app.

## What is prepared

- `scripts/hosted-backend.mts` starts the gateway and coordinator in one process. It binds to `PORT`, keeps policy and incident SQLite files in `NEVERDOWN_DATA_DIR`, and writes a mode-0600 payment worker file from cloud secrets. It removes Hedera signing keys from the parent process before loading the agent.
- `Dockerfile.backend` builds the pnpm workspace with Node 22. The image excludes `.env` and local SQLite files via `.dockerignore`.
- `fly.toml` keeps one 1 GB shared-CPU Machine running in Mumbai, serves HTTPS, and mounts `neverdown_data` at `/data`.
- Hosted `POST /rpc` requires `x-gateway-rpc-token`. The install API still requires the separate `x-gateway-internal-token`. Neither token belongs in browser code.

This is a single-machine demo deployment, not high availability. A paid standby entitlement is currently held in gateway memory and will be lost on machine restart; the configured preapproved standby still starts from environment settings. The seller's Heroku entitlement SQLite file is also not durable across dyno restarts. Both need a storage migration before production use.

## Deploy on Fly.io

Fly account login and billing must be configured before deployment. The machine and volume incur ongoing charges while running; check current [Fly pricing](https://fly.io/docs/about/pricing/). Do not scale beyond one Machine while these SQLite ledgers are in use.

```bash
flyctl auth login
flyctl apps create neverdown-backend
flyctl volumes create neverdown_data --region bom --size 1 --app neverdown-backend
node scripts/import-fly-secrets.mjs --dry-run
node scripts/import-fly-secrets.mjs neverdown-backend
flyctl deploy --ha=false
flyctl status --app neverdown-backend
```

The secret importer reads the ignored root `.env`, rejects missing required settings, omits local database paths, and sends only backend settings to `flyctl` over stdin without echoing values. If `GATEWAY_RPC_TOKEN` is absent, it generates one and appends it to the mode-0600 local `.env`. It does not import the ENS owner or Arkiv writer keys.

Set the app name in `fly.toml` and in the commands if `neverdown-backend` is unavailable. Configure the two gateway RPC URLs as independent Sepolia providers. The seller `x402Url` ENS record and `SELLER_URL` must still point at the Heroku seller; this deployment does not move the seller.

## Verify before calling it live

```bash
curl -fsS https://neverdown-backend.fly.dev/health
curl -fsS https://neverdown-backend.fly.dev/ready
curl -fsS https://neverdown-backend.fly.dev/status
flyctl logs --app neverdown-backend
```

The public `/rpc` route should return HTTP 401 without `x-gateway-rpc-token` and a Sepolia `eth_chainId` result with it. The authenticated `/_internal/ready` route should return HTTP 200 with `x-gateway-internal-token`. Test a machine restart and confirm policy and incident SQLite files remain on `/data`. Do not run a new paid procurement until those checks pass.

The Vercel console still uses local-only operator APIs. Connecting it to the hosted backend requires a separately authenticated API and UI work; do not put gateway tokens or Hedera credentials in the static site.
