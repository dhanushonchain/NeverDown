# @neverdown/core

Core rails for NeverDown's programmable resilience operator. This package is a dependency of `@neverdown/sdk`; most applications should use the SDK client.

Requires Node.js 22.13 or newer. The public package entry exports read-only ENS, Arkiv, and capability helpers plus a payment-worker IPC handle. It does not export the raw Hedera signing helpers, budget store, or HCS client. Import only from the documented package entry.

The payment worker runs as a child process. The SDK host must not have Hedera signing keys in its environment. The worker reads a separate mode-0600 environment file configured by `PAYMENT_WORKER_ENV_FILE`. This is a process and file-permission boundary, not separate OS-user isolation.

See the [NeverDown repository](https://github.com/dhanushonchain/NeverDown) for architecture, local testnet setup, and security limitations.
