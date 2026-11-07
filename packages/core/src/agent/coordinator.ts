import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

export type IncidentStatus = "STARTED" | "RETRYABLE" | "COMPLETED" | "FAILED" | "UNCERTAIN";
export type IncidentRecord = { incidentId: string; eventId: string; status: IncidentStatus; attempts: number; nextRetryAt: number | null; createdAt: string; updatedAt: string; receipt: unknown | null };
export type GatewayIncidentSnapshot = { runtimeId: string; recentEvents: Array<{ id: string; incidentId: string; reason: string; newActive: string | null }> };
export type ProcureResult = { success: boolean; purchase?: { status?: string } | null; steps?: Array<{ tool: string; ok: boolean; error?: string }> };
export type IncidentStore = {
  claim(incidentId: string, eventId: string): boolean | Promise<boolean>;
  finish(incidentId: string, status: Exclude<IncidentStatus, "STARTED">, receipt: unknown): void | Promise<void>;
  get(incidentId: string): IncidentRecord | undefined | Promise<IncidentRecord | undefined>;
  close(): void | Promise<void>;
};

export class IncidentLedger {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("CREATE TABLE IF NOT EXISTS incidents (incident_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, receipt_json TEXT, attempts INTEGER NOT NULL DEFAULT 1, next_retry_at INTEGER)");
    const columns = this.db.prepare("PRAGMA table_info(incidents)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "attempts")) this.db.exec("ALTER TABLE incidents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
    if (!columns.some((c) => c.name === "next_retry_at")) this.db.exec("ALTER TABLE incidents ADD COLUMN next_retry_at INTEGER");
  }

  claim(incidentId: string, eventId: string): boolean {
    const now = new Date(this.now()).toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO incidents (incident_id, event_id, status, created_at, updated_at) VALUES (?, ?, 'STARTED', ?, ?)").run(incidentId, eventId, now, now);
    if (result.changes === 1) return true;
    const retry = this.db.prepare("UPDATE incidents SET status = 'STARTED', attempts = attempts + 1, updated_at = ?, next_retry_at = NULL WHERE incident_id = ? AND status = 'RETRYABLE' AND next_retry_at <= ? AND attempts < 3").run(now, incidentId, this.now());
    return retry.changes === 1;
  }

  finish(incidentId: string, status: Exclude<IncidentStatus, "STARTED">, receipt: unknown): void {
    const json = JSON.stringify(receipt, (key, value) => key === "entitlementToken" ? undefined : typeof value === "bigint" ? value.toString() : value);
    const attempts = this.get(incidentId)?.attempts ?? 3;
    const finalStatus = status === "RETRYABLE" && attempts >= 3 ? "FAILED" : status;
    const nextRetryAt = finalStatus === "RETRYABLE" ? this.now() + 30_000 : null;
    this.db.prepare("UPDATE incidents SET status = ?, updated_at = ?, receipt_json = ?, next_retry_at = ? WHERE incident_id = ? AND status = 'STARTED'").run(finalStatus, new Date(this.now()).toISOString(), json, nextRetryAt, incidentId);
  }

  get(incidentId: string): IncidentRecord | undefined {
    const row = this.db.prepare("SELECT incident_id, event_id, status, created_at, updated_at, receipt_json, attempts, next_retry_at FROM incidents WHERE incident_id = ?").get(incidentId) as { incident_id: string; event_id: string; status: IncidentStatus; created_at: string; updated_at: string; receipt_json: string | null; attempts: number; next_retry_at: number | null } | undefined;
    if (!row) return undefined;
    return { incidentId: row.incident_id, eventId: row.event_id, status: row.status, attempts: row.attempts, nextRetryAt: row.next_retry_at, createdAt: row.created_at, updatedAt: row.updated_at, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null };
  }

  list(limit = 20): IncidentRecord[] {
    const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT incident_id FROM incidents ORDER BY created_at DESC, rowid DESC LIMIT ?").all(capped) as Array<{ incident_id: string }>;
    return rows.map((row) => this.get(row.incident_id)!).filter(Boolean);
  }

  close(): void { this.db.close(); }
}

export class IncidentCoordinator {
  private polling = false;
  constructor(private readonly ledger: IncidentStore, private readonly fetchStatus: () => Promise<GatewayIncidentSnapshot>, private readonly procure: (incidentId: string) => Promise<ProcureResult>) {}

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let snapshot: GatewayIncidentSnapshot;
      try { snapshot = await this.fetchStatus(); } catch { return; }
      for (const event of snapshot.recentEvents ?? []) {
        if (event.reason !== "failover completed" || event.newActive !== "standby" || !event.incidentId.startsWith(`${snapshot.runtimeId}:`)) continue;
        if (!await this.ledger.claim(event.incidentId, event.id)) continue;
        try {
          const receipt = await this.procure(event.incidentId);
          const retryDiscovery = !receipt.purchase && receipt.steps?.some((step) => step.tool === "discover_offers" && !step.ok && !!step.error);
          const status: Exclude<IncidentStatus, "STARTED"> = receipt.purchase?.status === "UNCERTAIN" ? "UNCERTAIN" : receipt.success ? "COMPLETED" : retryDiscovery ? "RETRYABLE" : "FAILED";
          await this.ledger.finish(event.incidentId, status, receipt);
        } catch {
          await this.ledger.finish(event.incidentId, "UNCERTAIN", { success: false, notes: ["procurement interrupted; reconcile before retry"] });
        }
      }
    } finally { this.polling = false; }
  }
}
