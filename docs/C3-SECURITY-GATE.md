# C3 Security Gate — agent handoff

**Read this before touching** `packages/core/src/policy/`, `hcs/`, `payment-worker/`, or C8 live `request_purchase`.

**Verdict:** PARTIAL (best-effort process boundary; not OS-enforced isolation).  
**C8 readiness:** Worker handoff is wired; live testnet acceptance and OS-enforced separation remain open.

Related: [C3-POLICY-HCS.md](./C3-POLICY-HCS.md) · [C8-AGENT.md](./C8-AGENT.md)

---

## What broke (fixed)

### Symptom

Live / worker purchase failed while hashing authorization evidence:

```text
Do not know how to serialize a BigInt
```

### Root cause

[`packages/core/src/hcs/evidence.ts`](../packages/core/src/hcs/evidence.ts) `canonicalize()` used `JSON.stringify` on nested objects that contain `bigint` (e.g. authorization `amountTinybars`). Native JSON cannot serialize `bigint`, so `hashCanonical(authorization)` threw mid-purchase.

### Fix (landed)

`canonicalize()` now converts `bigint` → decimal string before hashing / stringification. Do **not** reintroduce raw `JSON.stringify` on policy/auth records without a bigint replacer.

Also:

- Worker IPC integration test: [`packages/core/test/paymentWorkerIpc.test.ts`](../packages/core/test/paymentWorkerIpc.test.ts)
- Public-surface / no-key-leak tests: [`packages/core/test/security.test.ts`](../packages/core/test/security.test.ts)
- Worker credential file must be mode `0600` on unix (worker refuses unsafe env file). On Windows, POSIX mode bits are not enforced the same way — treat machine/user ACL as the boundary.
- Test fixtures include Hedera `feePayer` on payment requirements where needed

---

## Architecture agents must respect

```text
Untrusted agent / parent process
  │  IPC only: purchase ID, service ID, approved endpoint, selected offer terms + caller token
  │  NO HEDERA_SPEND_KEY, NO private keys in messages
  ▼
Payment worker (child process)
  │  loads secrets from root .env via PAYMENT_WORKER_ENV_FILE (mode 0600)
  │  authorize → reserve budget → sign/settle → HCS audit
  ▼
POLICY_DB_PATH SQLite + Hedera
```

**Public barrel** ([`packages/core/src/index.ts`](../packages/core/src/index.ts)) is intentionally **restricted**:

- Expose: policy config loaders, evidence hash helpers, `startPaymentWorker`, discover/PoC/ENS helpers, C8 agent types.
- Do **not** re-export: `payForRpcOnce`, `createHederaX402HttpClient`, `loadBuyerConfig`, `HederaHcsClient`, `openBudgetStore`, `securePurchase`.

`security.test.ts` asserts the banned names stay out of the barrel.

---

## Tests that already pass (do not regress)

| Suite | Intent |
|---|---|
| `paymentWorkerIpc.test.ts` | Real child process; unsafe cred file rejected; valid purchase settles; same `purchaseId` replay denied; IPC results JSON-safe; no key material in message shapes |
| `security.test.ts` | Restricted barrel; spend controls never disabled; protocol has no private-key fields |
| Core / sellers / gateway unit suites | Broader regression (run via package filters) |

Commands:

```bash
pnpm --filter @neverdown/core test
pnpm policy:smoke
```

---

## Remaining vulnerabilities (known — do not “fix” as closed)

These are **accepted hackathon limits** unless a chunk explicitly hardens them.

### 1. Same-OS-user file access

`POLICY_DB_PATH` SQLite and the root `.env` credential file are readable by any process running as the **same OS user** as the worker. If the agent host shares that user, it can open the DB or steal the cred file. There is **no** OS-user separation in this repo.

Mitigation today: `0600` on root `.env`; the scoped launcher keeps spend keys out of agent-visible env for live settle paths. This remains only process-environment isolation, because the agent runs under the same OS user and can read the file.

### 2. Replay detection is purchaseId-primary

Budget ledger uniqueness is keyed on `purchase_id`. Duplicate id → deny. Tampering on other dimensions must be caught by **policy fields** (allowlist, amount, endpoint, auth consume checks). There is no separate transactional write-ahead ledger beyond SQLite reservations + authorization records.

### 3. File-based worker secrets

Secrets live on disk in root `.env` (`PAYMENT_WORKER_ENV_FILE`). Not a vault / KMS / OS keychain. Treat file permissions and machine access as the trust boundary.

### 4. Thin malformed-IPC coverage

Happy-path + replay + unsafe file mode are covered. Coverage for corrupted challenges, truncated IPC frames, and weird extra fields is still **minimal**. Prefer adding tests in `paymentWorkerIpc.test.ts` / protocol unit tests before claiming a stronger gate.

### 5. C8 live worker path (not yet live-verified)

Hermetic C8 is fine (mocked tools).

**Live** [`createLiveToolBelt`](../packages/core/src/agent/tools.ts) now sends selected offer terms to the payment worker and requires a `SETTLED` outcome plus a credential before standby installation. The deny demonstration still evaluates policy in-process without signing. Hermetic IPC tests pass, but a configured Hedera testnet transaction through the full agent path has not been verified.

For live operation:

- Keep live `request_purchase` through `startPaymentWorker` / IPC only.
- Deny demos can still exercise policy without keys if they never reach sign.
- Do not load `HEDERA_SPEND_KEY` into the agent parent for live procure.

---

## Env notes (teammates)

See [`.env.example`](../.env.example).

| Var | Role |
|---|---|
| `POLICY_DB_PATH` | SQLite ledger (reservations, auth records, HCS outbox) |
| `PAYMENT_WORKER_ENV_FILE` | Root `.env` read by worker; must be mode `0600` |
| `POLICY_ENDPOINTS` | Approved seller base URLs for worker purchases |
| `POLICY_ALLOWLIST` | **Bare** Hedera account ids only (`0.0.123`), not `name:0.0.123` |
| `HEDERA_SPEND_*` | Belong in worker env for live settle — not in LLM/agent prompts |

---

## Agent / teammate rules

1. **Do not** “fix” C3 security by re-exporting signing helpers on the public barrel.
2. **Do not** put spend private keys in IPC payloads, logs, or evidence receipts.
3. If you touch `canonicalize` / `hashCanonical`, keep bigint-safe behavior and add a regression test.
4. If you change purchase auth, keep duplicate-`purchaseId` deny and worker IPC tests green.
5. Document any new residual risk here — do not silently claim FULL isolation.
6. Next product chunk remains **C9 UI**; security hardening is a **rail fix**, not a reason to rebuild C0–C7.

---

## Short status line (copy into chat handoffs)

> C3 BigInt hash bug fixed; payment worker IPC + security surface tests green; live C8 purchase now uses worker IPC. Verdict PARTIAL (same-OS-user DB/cred file; file-based secrets; full live testnet acceptance pending).
