# Heroku seller deployment

The Vercel deployment is static. This Heroku app hosts only the RPC demo seller. Gateway, coordinator, payment worker, and console API remain separate services.

The seller uses `DATABASE_URL` for durable paid entitlements on Heroku. A dyno refuses to start without it. Local development still uses ignored SQLite. Heroku provides `PORT`; the seller listens on it automatically.

## Deploy

1. Create a dedicated Heroku app from the repository root. Do not reuse an unrelated app.
2. Provision Heroku Postgres Essential-0. Heroku injects `DATABASE_URL`; do not print or commit it.
3. Set seller config vars: `HEDERA_MERCHANT_ACCOUNT_ID`, `HEDERA_NETWORK=testnet`, `HEDERA_X402_ASSET_ID=0.0.0`, `HEDERA_X402_PRICE_SMALLEST_UNITS`, `RPC_MODE=upstream`, `RPC_UPSTREAM_URL`, and `X402_FACILITATOR_URL=https://x402.org/facilitator`. Do not set buyer spend keys on the seller.
4. Deploy the Git branch to the Heroku app. Root `heroku-postbuild` compiles only the seller; `Procfile` starts it.
5. Use a Basic or higher web dyno for an always-available seller. Eco sleeps when idle.
6. Check `GET /health` returns 200, `POST /rpc-pack` returns 402 with `PAYMENT-REQUIRED`, and `/probe` passes the expected chain checks.
7. After the public URL is stable, set the ENS `x402Url` text on `neverdownseller.eth` to its exact base URL, update `SELLER_URL`, seed a matching Arkiv offer, then run `pnpm ens:check` and `pnpm preflight:live`.

Heroku Postgres is used for the seller's entitlement tokens only. The full backend needs durable policy and incident stores before its coordinator/worker can move to Heroku.
