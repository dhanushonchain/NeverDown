import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Durable paid entitlement store for Heroku's ephemeral dynos. */
export class PostgresEntitlementStore {
  private readonly pool: pg.Pool;
  private ready?: Promise<void>;

  constructor(databaseUrl: string, options?: { ssl?: false }) {
    const host = new URL(databaseUrl).hostname;
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: options?.ssl === false || host === "localhost" || host === "127.0.0.1"
        ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }

  private async ensureTable(): Promise<void> {
    this.ready ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS seller_entitlements (
        token_hash TEXT PRIMARY KEY,
        expires_at BIGINT NOT NULL,
        remaining INTEGER NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE
      )
    `).then(() => {}).catch((error: unknown) => { this.ready = undefined; throw error; });
    await this.ready;
  }

  async health(): Promise<boolean> {
    try { await this.ensureTable(); await this.pool.query("SELECT 1"); return true; }
    catch { return false; }
  }

  async issuePending(requests: number, durationMs: number): Promise<string> {
    if (!Number.isSafeInteger(requests) || requests < 1 || !Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error("invalid entitlement limits");
    await this.ensureTable();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.pool.query("DELETE FROM seller_entitlements WHERE expires_at <= $1", [now]);
    await this.pool.query("INSERT INTO seller_entitlements (token_hash, expires_at, remaining, active) VALUES ($1, $2, $3, FALSE)", [digest(token), now + durationMs, requests]);
    return token;
  }

  async activate(token: string): Promise<void> {
    await this.ensureTable();
    const result = await this.pool.query("UPDATE seller_entitlements SET active = TRUE WHERE token_hash = $1 AND expires_at > $2 AND active = FALSE RETURNING token_hash", [digest(token), Date.now()]);
    if (result.rowCount !== 1) throw new Error("pending entitlement unavailable");
  }

  async consume(token: string): Promise<boolean> {
    if (!token || token.length > 128) return false;
    await this.ensureTable();
    const result = await this.pool.query("UPDATE seller_entitlements SET remaining = remaining - 1 WHERE token_hash = $1 AND active = TRUE AND expires_at > $2 AND remaining > 0 RETURNING token_hash", [digest(token), Date.now()]);
    return result.rowCount === 1;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
