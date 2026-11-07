import { randomBytes, createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class EntitlementStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("CREATE TABLE IF NOT EXISTS entitlements (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, remaining INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0)");
  }

  health(): boolean { return true; }

  issuePending(requests: number, durationMs: number): string {
    if (!Number.isSafeInteger(requests) || requests < 1 || !Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error("invalid entitlement limits");
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM entitlements WHERE expires_at <= ?").run(this.now());
    this.db.prepare("INSERT INTO entitlements (token_hash, expires_at, remaining, active) VALUES (?, ?, ?, 0)").run(digest(token), this.now() + durationMs, requests);
    return token;
  }

  activate(token: string): void {
    const result = this.db.prepare("UPDATE entitlements SET active = 1 WHERE token_hash = ? AND expires_at > ? AND active = 0").run(digest(token), this.now());
    if (result.changes !== 1) throw new Error("pending entitlement unavailable");
  }

  consume(token: string): boolean {
    if (!token || token.length > 128) return false;
    const result = this.db.prepare("UPDATE entitlements SET remaining = remaining - 1 WHERE token_hash = ? AND active = 1 AND expires_at > ? AND remaining > 0").run(digest(token), this.now());
    return result.changes === 1;
  }

  close(): void { this.db.close(); }
}
