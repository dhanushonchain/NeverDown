# Live acceptance evidence

## SDK and failover acceptance (2026-11-07 IST)

The SDK's `NeverDown.procure` path settled one capped Hedera testnet purchase against the live Heroku seller and installed its RPC URL into a fresh, isolated gateway process. The gateway process was closed after the check; this was an acceptance run, not a persistent deployment.

| Item | Verified result |
|---|---|
| SDK read side | `pnpm sdk:smoke` passed for `neverdownseller.eth` and Arkiv offer `0x40edb65031b38fb0119d8e424026711046bb2d9d99914747cf6e9d82eb94e392` |
| Preflight | ENS, Arkiv, independent PoC, seller 402 challenge, and gateway status passed without payment |
| Initial policy denial | Incident `sdk-live:cc28a91c-b965-4053-a008-d650f1731d8c` used an unapproved service ID; worker returned `SERVICE_NOT_ALLOWED`, HCS sequence 19 recorded `PURCHASE_DENIED`, and no settle was requested |
| Successful SDK purchase | Incident `sdk-live:da7a73a8-5fca-48a3-9563-0c9b61b85ee9` used the configured policy service; SDK returned `SETTLED`, `installed: true`, and `auditStatus: published` |
| Hedera settlement | `0.0.9185802@1794012832.191533103`; testnet Mirror Node independently returned `SUCCESS` / `CRYPTOTRANSFER` |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9185802%401794012832.191533103 |
| HCS audit | Topic `0.0.11328605`, sequence 20 `PURCHASE_AUTHORIZED` and 21 `PAYMENT_SETTLED` for the same SDK incident; checked via testnet Mirror Node |
| Gateway install | SDK receipt reported `installed: true`; the fresh gateway's standby URL matched the purchased RPC endpoint |
| Live failover | `pnpm failover:live` used the configured Sepolia providers behind a local primary outage proxy. With no agent or payment, the gateway switched from primary to standby and served `eth_chainId=0xaa36a7` and `eth_blockNumber`. This verifies a controlled primary outage, not a naturally occurring upstream outage. |

The existing process on port 8787 returned 404 for the SDK's authenticated `/_internal/ready` check, so the SDK acceptance used a fresh gateway running current code. Restart long-running gateways after deploying the SDK readiness route.

## Current run (2026-11-07 IST)

The live RPC demo procurement flow completed against the Heroku seller. This is one demo adapter for NeverDown's broader resilience operator.

| Item | Verified result |
|---|---|
| ENS seller | `neverdownseller.eth`; mainnet `hederaAccount=0.0.11326899`, `x402Url=https://neverdown-seller-ff8be3d320ee.herokuapp.com`; `ens:check` passed |
| Arkiv offer | `0x40edb65031b38fb0119d8e424026711046bb2d9d99914747cf6e9d82eb94e392`; seed tx `0x38e24e167dae0e27ce61712473b91a6c7d573b0ba9435e4acc0c8506f069ce97` |
| Preflight | ENS, Arkiv, independent PoC, x402 challenge, gateway status passed |
| Hedera settlement | `0.0.9185802@1794002283.511364911`; Mirror Node `CRYPTOTRANSFER` result `SUCCESS` |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9185802%401794002283.511364911 |
| HCS audit | Topic `0.0.11328605`, sequence 13 `PURCHASE_AUTHORIZED`, sequence 14 `PAYMENT_SETTLED`; checked via testnet Mirror Node |
| Gateway install | Paid seller `/rpc` installed as standby; `/status` showed both providers healthy, active primary; a gateway `eth_chainId` read returned `0xaa36a7` |
| Deny path | Live policy check returned `RECIPIENT_NOT_ALLOWLISTED`; no payment for that check |

An earlier attempt on the same day settled at `0.0.9185802@1794002179.716711625` but installation failed because an older gateway process had its internal API disabled. The gateway was restarted with current configuration before the successful second purchase. The first payment is real and must not be reported as a completed install.

The earlier purchase run did not induce a primary outage. The later controlled live failover above used an isolated gateway and local outage proxy; it did not reuse the paid standby installed in the earlier run.

## Earlier run (2026-11-06)

Recorded from a configured local run. Secrets are not included.

| Item | Value |
|---|---|
| ENS seller | `neverdown.eth` (mainnet resolve; text overlay used for local rehearsal — publish on-chain texts for prize evidence) |
| Arkiv v2 entityKey | `0x74867aaf0276debc7b151f1a40e6c1cd4e06d14018539f01112a17738a63310d` |
| Arkiv seed tx | `0x13c652af10fa128c705ce0ac6be798a9c6960548d728decabb705c9987d9d2ac` |
| Hedera settle tx | `0.0.9185802@1793985063.486076384` |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9185802%401793985063.486076384 |
| Purchase audit | `published` |
| Deny demo | `RECIPIENT_NOT_ALLOWLISTED` for `0.0.99999999` (no settle) |
| Gateway after install | standby installed; `/ready` true; active primary |

## Commands that passed

```bash
pnpm ens:check
pnpm arkiv:seed && pnpm arkiv:query
pnpm seller:live   # separate process
pnpm gateway:live  # separate process
pnpm preflight:live
pnpm agent:live
pnpm agent:deny-live
```
