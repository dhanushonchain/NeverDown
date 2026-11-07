import pg from "pg";
import type { IncidentRecord, IncidentStatus, IncidentStore } from "./coordinator.js";

const { Pool } = pg;

/** Durable incident idempotency across Heroku dyno restarts. */
export class PostgresIncidentLedger implements IncidentStore {
  private readonly pool: pg.Pool;
  private ready?: Promise<void>;
  constructor(databaseUrl: string, private readonly now: () => number = Date.now) {
    const host = new URL(databaseUrl).hostname;
    this.pool = new Pool({ connectionString: databaseUrl, ssl: host === "localhost" || host === "127.0.0.1" ? false : { rejectUnauthorized: false }, max: 5 });
  }
  private async ensure(): Promise<void> {
    this.ready ??= this.pool.query("CREATE TABLE IF NOT EXISTS nd_incidents (incident_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, receipt_json TEXT, attempts INTEGER NOT NULL DEFAULT 1, next_retry_at BIGINT)")
      .then(() => {}).catch((error: unknown) => { this.ready = undefined; throw error; });
    await this.ready;
  }
  async claim(incidentId: string, eventId: string): Promise<boolean> {
    await this.ensure();
    const now = new Date(this.now()).toISOString();
    const inserted = await this.pool.query("INSERT INTO nd_incidents(incident_id,event_id,status,created_at,updated_at) VALUES($1,$2,'STARTED',$3,$3) ON CONFLICT DO NOTHING RETURNING incident_id",[incidentId,eventId,now]);
    if (inserted.rowCount === 1) return true;
    const retried = await this.pool.query("UPDATE nd_incidents SET status='STARTED',attempts=attempts+1,updated_at=$2,next_retry_at=NULL WHERE incident_id=$1 AND status='RETRYABLE' AND next_retry_at <= $3 AND attempts < 3 RETURNING incident_id",[incidentId,now,this.now()]);
    return retried.rowCount === 1;
  }
  async finish(incidentId: string, status: Exclude<IncidentStatus,"STARTED">, receipt: unknown): Promise<void> {
    await this.ensure();
    const record = await this.get(incidentId);
    const finalStatus = status === "RETRYABLE" && (record?.attempts ?? 3) >= 3 ? "FAILED" : status;
    const nextRetryAt = finalStatus === "RETRYABLE" ? this.now() + 30_000 : null;
    const json = JSON.stringify(receipt, (key, value) => key === "entitlementToken" ? undefined : typeof value === "bigint" ? value.toString() : value);
    await this.pool.query("UPDATE nd_incidents SET status=$2,updated_at=$3,receipt_json=$4,next_retry_at=$5 WHERE incident_id=$1 AND status='STARTED'",[incidentId,finalStatus,new Date(this.now()).toISOString(),json,nextRetryAt]);
  }
  async get(incidentId: string): Promise<IncidentRecord | undefined> {
    await this.ensure(); const result = await this.pool.query("SELECT * FROM nd_incidents WHERE incident_id=$1",[incidentId]);
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return { incidentId: row.incident_id, eventId: row.event_id, status: row.status, attempts: row.attempts, nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at), createdAt: row.created_at, updatedAt: row.updated_at, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null };
  }
  async list(limit = 20): Promise<IncidentRecord[]> {
    await this.ensure();
    const capped = Math.max(1,Math.min(100,Math.trunc(limit)));
    const result = await this.pool.query("SELECT incident_id FROM nd_incidents ORDER BY created_at DESC, incident_id DESC LIMIT $1",[capped]);
    return (await Promise.all(result.rows.map((row: {incident_id:string}) => this.get(row.incident_id)))).filter((record): record is IncidentRecord => Boolean(record));
  }
  async close(): Promise<void> { await this.pool.end(); }
}
