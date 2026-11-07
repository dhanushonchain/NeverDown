# Heroku backend

The live backend runs in the `neverdown-backend` Heroku app. Its web dyno hosts the RPC fast plane and polls failover incidents for procurement. The seller is a separate Heroku app, `neverdown-seller`. Both attach to the existing Heroku Postgres add-on; their tables are namespaced (`nd_*` and `seller_entitlements`). The Vercel site remains a static preview and does not yet control this hosted backend.

## Deployment

`heroku.yml` builds `Dockerfile.backend` for the backend app. Keep the seller app on its existing Node buildpack and Procfile. To deploy from this checkout:

```bash
heroku addons:attach neverdown-seller::DATABASE --app neverdown-backend
node scripts/import-heroku-config.mjs neverdown-backend --dry-run
node scripts/import-heroku-config.mjs neverdown-backend
heroku git:remote -a neverdown-backend -r heroku-backend
git push heroku-backend HEAD:main
heroku ps:scale web=1:basic -a neverdown-backend
```

The importer reads the ignored root `.env` (mode 0600), hides values, and sends only backend settings. The existing Postgres attachment supplies `DATABASE_URL`. It also enables the authenticated install API, coordinator, and durable HCS audit. Do not use `heroku config` without a key name: the full listing reveals credentials. Avoid adding `DATABASE_URL` to `.env` because Heroku supplies it.

On boot, the process writes a mode-0600 worker file in `/tmp` from Heroku config, removes signing keys from the parent process, and starts the gateway and coordinator. Policy reservations, HCS outbox, and incident claims live in Postgres. The worker still shares a dyno user with the parent process; this is process level separation, not OS isolation.

## Checks

- `GET /health`, `/ready`, `/status` should work without credentials.
- `POST /rpc` must return 401 without `x-gateway-rpc-token`, and work with it.
- `GET /_internal/ready` must require `x-gateway-internal-token`.
- After a dyno restart, Postgres incident and policy rows must remain; paid seller entitlements must survive seller restarts.
- Keep the two gateway RPC URLs independent. The ENS `x402Url` and `SELLER_URL` must point to the existing seller app.

The backend is a single web dyno. A dynamically installed standby URL and entitlement token currently live in gateway memory and are lost on restart. The configured preapproved standby survives through config. Do not claim high availability or durable dynamic installation yet. Use a server-side proxy for browser integrations; never expose gateway tokens or Hedera keys in frontend code.
