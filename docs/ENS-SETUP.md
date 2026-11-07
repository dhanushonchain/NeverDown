# ENS setup for live NeverDown

Live preflight resolves the seller on **mainnet or Sepolia** ENS (`ENS_RPC_URL` → chain id `0x1` or `0xaa36a7`).

Resolution uses the classic registry when present, then falls back to the **Universal Resolver** so **ENSv2** names work.

## Demo identity

**`neverdownseller.eth`** (ENSv2 mainnet)

| Field | Value |
|---|---|
| Resolved address / owner wallet | `0x9a9a558b0AA2BFAbAC7C44F4BeA6DA569053999B` |
| Resolver | via Universal Resolver `0xeEeE…eEeE` |

Alternative still valid: **`neverdown.eth`** (classic mainnet, owner `0x4Df6e0f9Ed361C116bB3D480Ea26700E531c40C8`).

## Required text records

| Key | Value |
|---|---|
| `hederaAccount` | Merchant Hedera account, e.g. `0.0.11326899` |
| `x402Url` | Seller base URL (public HTTPS tunnel or `http://localhost:4001`) |
| `category` | `rpc` (optional) |

Set in [app.ens.domains/neverdownseller.eth](https://app.ens.domains/neverdownseller.eth) → **Edit** (wallet must hold **mainnet ETH** for gas), or:

```bash
ENS_OWNER_PRIVATE_KEY=0x... pnpm ens:set-texts
pnpm ens:check
```

`ENS_OWNER_PRIVATE_KEY` must be the name controller (`0x9a9a…999B` for `neverdownseller.eth`). Never commit it.

## Env

```env
SELLER_ENS_NAME=neverdownseller.eth
ENS_RPC_URL=https://ethereum-rpc.publicnode.com
ENS_ALLOWLIST_NAMES=neverdownseller.eth
```

Set these values in the single root `.env`; the commands read it automatically.

## Local rehearsal overlay (not for judge evidence)

If the owner key is unavailable during local rehearsal, root `.env` may set:

```env
ENS_ALLOW_TEXT_OVERLAY=true
ENS_TEXT_hederaAccount=0.0.11326899
ENS_TEXT_x402Url=http://localhost:4001
```

The name must still **resolve** (ENSv2 address lookup succeeds). Overlay only fills **missing** texts.  
**Turn overlay off** and publish real on-chain texts before recording submission ENS evidence.
