import pg from "pg";
import { LedgerError, type BudgetLedger, type ReservationRecord, type ReservationState } from "./budgetStore.js";

const { Pool } = pg;
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

/** Shared, durable policy ledger. All cap checks lock the policy row. */
export class PostgresBudgetStore implements BudgetLedger {
  private readonly pool: pg.Pool;
  private ready?: Promise<void>;
  constructor(databaseUrl: string) {
    const host = new URL(databaseUrl).hostname;
    this.pool = new Pool({ connectionString: databaseUrl, ssl: host === "localhost" || host === "127.0.0.1" ? false : { rejectUnauthorized: false }, max: 5 });
  }
  private async ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS nd_policy_state (policy_id TEXT PRIMARY KEY, initial_spent NUMERIC(40,0) NOT NULL DEFAULT 0)`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS nd_purchase_reservations (purchase_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, seller_pay_to TEXT NOT NULL, amount_tinybars NUMERIC(40,0) NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT, transaction_id TEXT, reason TEXT)`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS nd_authorization_records (purchase_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, record_json TEXT NOT NULL)`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS nd_hcs_outbox (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, policy_id TEXT, event_type TEXT NOT NULL, event_json TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, transaction_id TEXT, sequence_number BIGINT, consensus_timestamp TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_attempt_at TEXT, created_at TEXT NOT NULL)`);
    })().catch((error: unknown) => { this.ready = undefined; throw error; });
    await this.ready;
  }
  async initializePolicy(policyId: string, spent = 0n): Promise<void> { await this.ensure(); await this.pool.query("INSERT INTO nd_policy_state(policy_id,initial_spent) VALUES ($1,$2) ON CONFLICT DO NOTHING", [policyId, String(spent)]); }
  async initialize(policyId: string, spent = 0n): Promise<void> { await this.initializePolicy(policyId, spent); }
  async getCommittedOrReserved(policyId: string): Promise<bigint> { await this.ensure(); const r = await this.pool.query("SELECT COALESCE(SUM(amount_tinybars),0)::text AS total FROM nd_purchase_reservations WHERE policy_id=$1 AND state IN ('RESERVED','SETTLED','UNCERTAIN','SIGNING')", [policyId]); return BigInt(r.rows[0].total); }
  async totalCommittedOrReserved(policyId: string): Promise<bigint> { await this.ensure(); const r = await this.pool.query("SELECT COALESCE(initial_spent,0)::text AS spent FROM nd_policy_state WHERE policy_id=$1", [policyId]); return (r.rowCount ? BigInt(r.rows[0].spent) : 0n) + await this.getCommittedOrReserved(policyId); }
  async reserveAtomic(purchaseId: string, policyId: string, sellerPayTo: string, amount: bigint, totalBudget: bigint, maxPerPayment: bigint): Promise<void> {
    await this.initializePolicy(policyId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query("SELECT initial_spent::text AS spent FROM nd_policy_state WHERE policy_id=$1 FOR UPDATE", [policyId]);
      const duplicate = await client.query("SELECT 1 FROM nd_purchase_reservations WHERE purchase_id=$1", [purchaseId]);
      if (duplicate.rowCount) throw new Error(`purchase_id already exists: ${purchaseId}`);
      const used = await client.query("SELECT COALESCE(SUM(amount_tinybars),0)::text AS total FROM nd_purchase_reservations WHERE policy_id=$1 AND state IN ('RESERVED','SETTLED','UNCERTAIN','SIGNING')", [policyId]);
      if (amount > maxPerPayment) throw new Error("per-payment cap exceeded");
      if (BigInt(state.rows[0].spent) + BigInt(used.rows[0].total) + amount > totalBudget) throw new Error("cumulative budget exceeded");
      await client.query("INSERT INTO nd_purchase_reservations(purchase_id,policy_id,seller_pay_to,amount_tinybars,state,created_at) VALUES($1,$2,$3,$4,'RESERVED',$5)", [purchaseId, policyId, sellerPayTo, String(amount), new Date().toISOString()]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async reserve(purchaseId: string, policyId: string, sellerPayTo: string, amount: bigint, state: ReservationState = "RESERVED"): Promise<ReservationRecord> {
    if (state === "REQUESTED") throw new Error("reserve must land in a concrete state");
    await this.ensure();
    await this.pool.query("INSERT INTO nd_purchase_reservations(purchase_id,policy_id,seller_pay_to,amount_tinybars,state,created_at) VALUES($1,$2,$3,$4,$5,$6)", [purchaseId,policyId,sellerPayTo,String(amount),state,new Date().toISOString()]);
    return (await this.get(purchaseId))!;
  }
  async get(purchaseId: string): Promise<ReservationRecord | undefined> {
    await this.ensure(); const r = await this.pool.query("SELECT * FROM nd_purchase_reservations WHERE purchase_id=$1", [purchaseId]);
    if (!r.rowCount) return undefined; const row = r.rows[0];
    return { id: row.purchase_id, purchaseId: row.purchase_id, policyId: row.policy_id, sellerPayTo: row.seller_pay_to, amountTinybars: BigInt(row.amount_tinybars), state: row.state, createdAt: row.created_at, settledAt: row.settled_at ?? undefined, transactionId: row.transaction_id ?? undefined, reason: row.reason ?? undefined };
  }
  async setTransaction(purchaseId: string, transactionId: string): Promise<void> { await this.ensure(); await this.pool.query("UPDATE nd_purchase_reservations SET transaction_id=$2,settled_at=$3 WHERE purchase_id=$1", [purchaseId,transactionId,new Date().toISOString()]); }
  async transition(purchaseId: string, state: ReservationState, reason?: string): Promise<void> { await this.ensure(); await this.pool.query("UPDATE nd_purchase_reservations SET state=$2,reason=$3 WHERE purchase_id=$1", [purchaseId,state,reason ?? null]); }
  async saveAuthorization(record: unknown): Promise<void> { await this.ensure(); const r = record as {purchaseId:string;policyId:string}; await this.pool.query("INSERT INTO nd_authorization_records(purchase_id,policy_id,record_json) VALUES($1,$2,$3) ON CONFLICT(purchase_id) DO UPDATE SET record_json=EXCLUDED.record_json", [r.purchaseId,r.policyId,json(record)]); }
  async loadAuthorization(purchaseId: string): Promise<unknown> { await this.ensure(); const r = await this.pool.query("SELECT record_json FROM nd_authorization_records WHERE purchase_id=$1",[purchaseId]); return r.rowCount ? JSON.parse(r.rows[0].record_json) : undefined; }
  async enqueueOutbox(input: { id:string;purchaseId:string;policyId?:string;eventType:string;event:unknown;contentHash:string;status:string;createdAt:string }): Promise<void> { await this.ensure(); await this.pool.query("INSERT INTO nd_hcs_outbox(id,purchase_id,policy_id,event_type,event_json,content_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[input.id,input.purchaseId,input.policyId ?? null,input.eventType,json(input.event),input.contentHash,input.status,input.createdAt]); }
  async getOutbox(id:string): Promise<any> { await this.ensure(); const r = await this.pool.query("SELECT * FROM nd_hcs_outbox WHERE id=$1",[id]); return r.rows[0]; }
  async markOutboxAnchored(id:string, sequenceNumber?:number, consensusTimestamp?:string, transactionId?:string): Promise<void> { await this.ensure(); await this.pool.query("UPDATE nd_hcs_outbox SET status='anchored',sequence_number=$2,consensus_timestamp=$3,transaction_id=$4,last_attempt_at=$5 WHERE id=$1",[id,sequenceNumber ?? null,consensusTimestamp ?? null,transactionId ?? null,new Date().toISOString()]); }
  async markOutboxFailed(id:string,message:string): Promise<void> { await this.ensure(); await this.pool.query("UPDATE nd_hcs_outbox SET status='pending',last_error=$2,attempts=attempts+1,last_attempt_at=$3 WHERE id=$1",[id,message,new Date().toISOString()]); }
  ledgerError(code:string,message:string): never { throw new LedgerError(code,message); }
  async consumeForSigning(purchaseId:string,policyId:string,sellerPayTo:string,amount:bigint,authorizationExpiresAt:string,now=new Date().toISOString()): Promise<void> {
    await this.ensure(); const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r=await client.query("SELECT * FROM nd_purchase_reservations WHERE purchase_id=$1 FOR UPDATE",[purchaseId]);
      if (!r.rowCount) throw new LedgerError("NO_RESERVATION","no durable reservation for purchase");
      if (r.rows[0].state!=="RESERVED") throw new LedgerError("NOT_RESERVED",`purchase is in state ${r.rows[0].state}, not RESERVED`);
      if (r.rows[0].policy_id!==policyId) throw new LedgerError("AUTHORIZATION_MISMATCH","policy_id does not match reservation");
      if (Date.parse(authorizationExpiresAt)<=Date.parse(now)) throw new LedgerError("AUTHORIZATION_EXPIRED","authorization expired");
      const a=await client.query("SELECT record_json FROM nd_authorization_records WHERE purchase_id=$1",[purchaseId]);
      if (!a.rowCount) throw new LedgerError("NO_AUTHORIZATION","no durable authorization record");
      let auth: {sellerPayTo:string;amountTinybars:string;policyId:string;expiresAt?:string};
      try { auth=JSON.parse(a.rows[0].record_json); } catch { throw new LedgerError("NO_AUTHORIZATION","authorization is not parseable"); }
      if (auth.policyId!==policyId || auth.sellerPayTo!==sellerPayTo || BigInt(auth.amountTinybars)!==amount) throw new LedgerError("AUTHORIZATION_MISMATCH","authorization terms changed");
      if (!auth.expiresAt || Date.parse(auth.expiresAt)<=Date.parse(now)) throw new LedgerError("AUTHORIZATION_EXPIRED","authorization expired or missing expiry");
      await client.query("UPDATE nd_purchase_reservations SET state='SIGNING',reason='claiming' WHERE purchase_id=$1",[purchaseId]);
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async releaseOnPreSigningFailure(purchaseId:string,reason:string): Promise<boolean> { await this.ensure(); const r=await this.pool.query("UPDATE nd_purchase_reservations SET state='RELEASED',reason=$2 WHERE purchase_id=$1 AND state='RESERVED' RETURNING purchase_id",[purchaseId,reason]); return r.rowCount===1; }
  async markSettled(purchaseId:string,transactionId:string): Promise<boolean> { await this.ensure(); const r=await this.pool.query("UPDATE nd_purchase_reservations SET state='SETTLED',transaction_id=$2,settled_at=$3 WHERE purchase_id=$1 AND state='SIGNING' RETURNING purchase_id",[purchaseId,transactionId,new Date().toISOString()]); return r.rowCount===1; }
  async markUncertain(purchaseId:string,reason:string): Promise<boolean> { await this.ensure(); const r=await this.pool.query("UPDATE nd_purchase_reservations SET state='UNCERTAIN',reason=$2 WHERE purchase_id=$1 AND state='SIGNING' RETURNING purchase_id",[purchaseId,reason]); return r.rowCount===1; }
  async recoverAfterRestart(): Promise<{released:number;uncertain:number}> { await this.ensure(); const r=await this.pool.query("UPDATE nd_purchase_reservations SET state='UNCERTAIN',reason='worker crashed during signing' WHERE state='SIGNING' RETURNING purchase_id"); return {released:0,uncertain:r.rowCount ?? 0}; }
  async close(): Promise<void> { await this.pool.end(); }
}
