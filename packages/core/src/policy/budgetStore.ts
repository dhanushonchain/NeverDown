import { DatabaseSync } from "node:sqlite";

export type ReservationState = "REQUESTED" | "RESERVED" | "DENIED" | "SETTLED" | "RELEASED" | "UNCERTAIN";
export type ReservationRecord = {
  id: string;
  purchaseId: string;
  policyId: string;
  sellerPayTo: string;
  amountTinybars: bigint;
  state: ReservationState;
  createdAt: string;
  settledAt?: string;
  transactionId?: string;
  reason?: string;
};

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name="LedgerError"; this.code=code; }
}
export type MaybePromise<T> = T | Promise<T>;
export type BudgetLedger = {
  [K in keyof BudgetStore]: BudgetStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => MaybePromise<R>
    : BudgetStore[K];
};
export class BudgetStore {
  private db: DatabaseSync;

  constructor(dbPath = process.env.POLICY_DB_PATH ?? "neverdown-policy.sqlite") {
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS purchase_reservations (
      purchase_id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      seller_pay_to TEXT NOT NULL,
      amount_tinybars TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      transaction_id TEXT,
      reason TEXT,
      details TEXT
    );`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS policy_state (
      policy_id TEXT PRIMARY KEY,
      initial_spent TEXT NOT NULL DEFAULT '0'
    );`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS authorization_records (
      purchase_id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      record_json TEXT NOT NULL
    );`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS hcs_outbox (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL,
      policy_id TEXT,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      transaction_id TEXT,
      sequence_number INTEGER,
      consensus_timestamp TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL
    );`);
  }

  initializePolicy(policyId: string, spentTinybars = 0n): void {
    this.db.prepare("INSERT OR IGNORE INTO policy_state(policy_id,initial_spent) VALUES (?, ?)")
      .run(policyId, spentTinybars.toString());
  }

  getCommittedOrReserved(policyId: string): bigint {
    const row = this.db.prepare("SELECT COALESCE(SUM(CAST(amount_tinybars AS TEXT)),0) AS total FROM purchase_reservations WHERE policy_id=? AND state IN ('RESERVED','SETTLED','UNCERTAIN')").get(policyId) as { total: string | number };
    return BigInt(row.total ?? 0);
  }

  reserve(purchaseId: string, policyId: string, sellerPayTo: string, amount: bigint, state: ReservationState = "RESERVED"): ReservationRecord {
    const now = new Date().toISOString();
    const insert = () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.db.prepare("SELECT * FROM purchase_reservations WHERE purchase_id=?").get(purchaseId) as any;
        if (existing) { this.db.exec("COMMIT"); throw new Error(`duplicate purchase id: ${purchaseId}`); }
        this.db.prepare("INSERT INTO purchase_reservations(purchase_id,policy_id,seller_pay_to,amount_tinybars,state,created_at) VALUES (?,?,?,?,?,?)")
          .run(purchaseId, policyId, sellerPayTo, amount.toString(), state, now);
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    };
    if (state === "REQUESTED") throw new Error("reserve must land in a concrete state");
    insert();
    return this.get(purchaseId)!;
  }

  get(purchaseId: string): ReservationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM purchase_reservations WHERE purchase_id=?").get(purchaseId) as any;
    if (!row) return undefined;
    return {
      id: String(row.purchase_id),
      purchaseId: String(row.purchase_id),
      policyId: String(row.policy_id),
      sellerPayTo: String(row.seller_pay_to),
      amountTinybars: BigInt(row.amount_tinybars),
      state: row.state as ReservationState,
      createdAt: String(row.created_at),
      transactionId: row.transaction_id ?? undefined,
      reason: row.reason ?? undefined,
      settledAt: row.settled_at ?? undefined,
    };
  }

  setTransaction(purchaseId: string, transactionId: string): void {
    this.db.prepare("UPDATE purchase_reservations SET transaction_id=?, settled_at=? WHERE purchase_id=?")
      .run(transactionId, new Date().toISOString(), purchaseId);
  }

  transition(purchaseId: string, state: ReservationState, reason?: string): void {
    this.db.prepare("UPDATE purchase_reservations SET state=?, reason=? WHERE purchase_id=?").run(state, reason ?? null, purchaseId);
  }

  totalCommittedOrReserved(policyId: string): bigint {
    const committed = this.db.prepare("SELECT Coalesce((SELECT initial_spent FROM policy_state WHERE policy_id=?),0) AS s").get(policyId) as { s: string | number };
    const initial = BigInt(committed?.s ?? 0);
    return this.getCommittedOrReserved(policyId) + initial;
  }

  initialize(policyId: string, spent = 0n): void { this.initializePolicy(policyId, spent); }
  saveAuthorization(record: unknown): void {
    const r = record as { purchaseId: string; policyId: string };
    this.db.prepare("INSERT OR REPLACE INTO authorization_records(purchase_id,policy_id,record_json) VALUES (?,?,?)")
      .run(r.purchaseId, r.policyId, JSON.stringify(record, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  }

  loadAuthorization(purchaseId: string): unknown {
    const row = this.db.prepare("SELECT record_json FROM authorization_records WHERE purchase_id=?").get(purchaseId) as { record_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.record_json);
  }

  enqueueOutbox(input: { id: string; purchaseId: string; policyId?: string; eventType: string; event: unknown; contentHash: string; status: string; createdAt: string }): void {
    this.db.prepare(`INSERT INTO hcs_outbox(id,purchase_id,policy_id,event_type,event_json,content_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(input.id, input.purchaseId, input.policyId ?? null, input.eventType, JSON.stringify(input.event), input.contentHash, input.status, input.createdAt);
  }

  getOutbox(id: string): any {
    return this.db.prepare("SELECT * FROM hcs_outbox WHERE id=?").get(id) as any;
  }

  markOutboxAnchored(id: string, sequenceNumber?: number, consensusTimestamp?: string, transactionId?: string): void {
    this.db.prepare("UPDATE hcs_outbox SET status='anchored',sequence_number=?,consensus_timestamp=?,transaction_id=?,last_attempt_at=? WHERE id=?")
      .run(sequenceNumber ?? null, consensusTimestamp ?? null, transactionId ?? null, new Date().toISOString(), id);
  }

  markOutboxFailed(id: string, message: string): void {
    this.db.prepare("UPDATE hcs_outbox SET status='pending',last_error=?,attempts=attempts+1,last_attempt_at=? WHERE id=?")
      .run(message, new Date().toISOString(), id);
  }


  ledgerError(code: string, message: string): never { throw new LedgerError(code,message); }

  /** Atomically move a RESERVED purchase to SIGNING right before signing. */
  consumeForSigning(purchaseId: string, policyId: string, sellerPayTo: string, amount: bigint, authorizationExpiresAt: string, now: string = new Date().toISOString()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM purchase_reservations WHERE purchase_id=?").get(purchaseId) as any;
      if (!row) { this.db.exec("COMMIT"); throw new LedgerError("NO_RESERVATION", "no durable reservation for purchase"); }
      if (row.state !== "RESERVED") { this.db.exec("COMMIT"); throw new LedgerError("NOT_RESERVED", `purchase is in state ${row.state}, not RESERVED`); }
      if (String(row.policy_id) !== policyId) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_MISMATCH", "policy_id does not match reservation"); }
      if (Date.parse(authorizationExpiresAt) <= Date.parse(now)) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_EXPIRED", "authorization expired"); }
      const auth = this.db.prepare("SELECT record_json FROM authorization_records WHERE purchase_id=?").get(purchaseId) as { record_json: string } | undefined;
      if (!auth) { this.db.exec("COMMIT"); throw new LedgerError("NO_AUTHORIZATION", "no durable authorization record"); }
      let parsed: { sellerPayTo: string; amountTinybars: string | number; policyId: string };
      try { parsed = JSON.parse(auth.record_json); } catch { this.db.exec("COMMIT"); throw new LedgerError("NO_AUTHORIZATION", "authorization is not parseable"); }
      if (String(parsed.policyId) !== policyId) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_MISMATCH", "policy_id mismatch"); }
      if (parsed.sellerPayTo !== sellerPayTo) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_MISMATCH", "payTo changed since authorization"); }
      if (BigInt(parsed.amountTinybars) !== amount) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_MISMATCH", "amount changed since authorization"); }
      const authExpires = (parsed as { expiresAt?: string }).expiresAt;
      if (!authExpires || Date.parse(authExpires) <= Date.parse(now)) { this.db.exec("COMMIT"); throw new LedgerError("AUTHORIZATION_EXPIRED", "authorization expired or missing expiry"); }
      this.db.prepare("UPDATE purchase_reservations SET state='SIGNING',reason=? WHERE purchase_id=? AND state='RESERVED'")
        .run("claiming", purchaseId);
      // check row changed
      const cur = this.db.prepare("SELECT state FROM purchase_reservations WHERE purchase_id=?").get(purchaseId) as { state: string };
      if (cur.state !== "SIGNING") { this.db.exec("ROLLBACK"); throw new LedgerError("NOT_RESERVED","concurrent claim rejected"); }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (e instanceof LedgerError) throw e;
      throw e;
    }
  }

  /** Definitive pre-signing failure: release reservation to free budget. Only reserved purchases. */
  releaseOnPreSigningFailure(purchaseId: string, reason: string): boolean {
    const row = this.db.prepare("SELECT state FROM purchase_reservations WHERE purchase_id=?").get(purchaseId) as { state: string } | undefined;
    if (!row || row.state !== "RESERVED") return false;
    this.db.prepare("UPDATE purchase_reservations SET state='RELEASED',reason=? WHERE purchase_id=? AND state='RESERVED'").run(reason, purchaseId);
    return true;
  }

  markSettled(purchaseId: string, transactionId: string): boolean {
    const res = this.db.prepare("UPDATE purchase_reservations SET state='SETTLED',transaction_id=?,settled_at=? WHERE purchase_id=? AND state='SIGNING'")
      .run(transactionId, new Date().toISOString(), purchaseId) as { changes: number };
    return Number(res.changes||0) > 0;
  }

  markUncertain(purchaseId: string, reason: string): boolean {
    const res = this.db.prepare("UPDATE purchase_reservations SET state='UNCERTAIN',reason=? WHERE purchase_id=? AND state='SIGNING'")
      .run(reason, purchaseId) as { changes: number };
    return Number(res.changes||0) > 0;
  }

  recoverAfterRestart(): { released: number; uncertain: number } {
    let uncertain = 0;
    try {
      const res = this.db.prepare("UPDATE purchase_reservations SET state='UNCERTAIN',reason=? WHERE state='SIGNING'").run("worker crashed during signing") as { changes: number };
      uncertain = Number(res.changes||0);
    } catch {}
    // RESERVED that may have been interrupted pre-signing get released? Keep conservative: leave RESERVED. They are still eligible.
    return { released: 0, uncertain };
  }

  close(): void { this.db.close(); }
  reserveAtomic(purchaseId: string, policyId: string, sellerPayTo: string, amount: bigint, totalBudget: bigint, maxPerPayment: bigint): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const req: any = this.db.prepare("SELECT * FROM purchase_reservations WHERE purchase_id=?").get(purchaseId);
      if (req) throw new Error(`purchase_id already exists: ${purchaseId}`);
      const totalUsed = this.getCommittedOrReserved(policyId);
      if (amount > maxPerPayment) throw new Error("per-payment cap exceeded");
      if (totalBudget > 0n && totalUsed + amount > totalBudget) throw new Error("cumulative budget exceeded");
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO purchase_reservations(purchase_id,policy_id,seller_pay_to,amount_tinybars,state,created_at) VALUES (?,?,?,?,?,?)")
        .run(purchaseId, policyId, sellerPayTo, amount.toString(), "RESERVED", now);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
}

export function openBudgetStore(dbPath?: string): BudgetStore {
  return new BudgetStore(dbPath);
}
