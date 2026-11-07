# Live acceptance evidence

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

A live primary outage was not induced. Gateway failover and paid standby routing passed 19 hermetic gateway tests; the live run verified procurement and installation while the primary remained healthy.

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
