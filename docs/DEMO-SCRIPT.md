# NeverDown — demo scripts

Product framing: **programmable resilience operator**. RPC is the hackathon demo vertical only.

## 90-second click path (local console)

1. `pnpm seller:live` · `pnpm gateway:live` · `pnpm web:dev` (separate terminals; all read root `.env`).
2. Open `http://localhost:3000`.
3. **Act 1 — Contract:** show allowlist / budget; click denial test.
4. **Act 2 — Status:** refresh gateway; show primary + standby healthy.
5. **Act 3 — Procure:** run procurement (hermetic by default; `AGENT_LIVE=true` for real settle).
6. **Act 4 — Deny:** bad recipient → `RECIPIENT_NOT_ALLOWLISTED`.
7. **Act 5 — Evidence:** HashScan + Arkiv entity + ENS (`neverdown.eth`).

Live proof IDs: [LIVE-EVIDENCE.md](./LIVE-EVIDENCE.md).

## 5-minute video beats

| Time | Beat |
|---|---|
| 0:00–0:30 | Pitch: failure spot → Resilience Contract → fast plane + procurement |
| 0:30–1:00 | Kill/show primary unhealthy → standby serves (no LLM) |
| 1:00–2:30 | Procure: Arkiv offer → ENS → PoC → worker settle → HashScan |
| 2:30–3:15 | Deny attack: off-allowlist → no sign |
| 3:15–4:00 | Evidence board: HashScan, Arkiv entity, ENS, HCS topic |
| 4:00–5:00 | Prize rails + honesty (C3 PARTIAL isolation) + what’s next |

## CLI fallback (no UI)

```bash
pnpm preflight:live
pnpm agent:live
pnpm agent:deny-live
```
