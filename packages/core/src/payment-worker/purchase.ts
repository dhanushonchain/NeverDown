import { loadPolicyConfig } from "../policy/config.js";
import { loadHcsConfig } from "../hcs/config.js";
import { authorizePurchase } from "../policy/engine.js";
import type { PolicyConfig } from "../policy/types.js";
import type { PurchaseOutcome } from "../policy/types.js";
import { BudgetStore, type BudgetLedger } from "../policy/budgetStore.js";
import { PostgresBudgetStore } from "../policy/postgresBudgetStore.js";
import { payForRpcOnce, payForRpcPack } from "../x402/payOnce.js";
import type { PurchaseRequest } from "./protocol.js";
import { createHederaX402HttpClient } from "../x402/client.js";
import type { HederaBuyerCredentials } from "../x402/client.js";
import { hashCanonical } from "../hcs/evidence.js";
import { HederaHcsClient } from "../hcs/client.js";

const HEDERA_ACCOUNT_ID = /^0\.0\.[1-9]\d*$/;

export type PurchaseDeps = {
  policy: PolicyConfig;
  store: BudgetLedger;
  audit?: { config?: ReturnType<typeof loadHcsConfig>; };

  // injectables for tests
  fetchImpl?: typeof fetch;
  createHttpClient?: (creds: HederaBuyerCredentials) => any;
  auditClient?: {
    submit: (event: any) => Promise<{ status: "disabled" | "published" | "failed"; transactionId?: string; sequenceNumber?: number; consensusTimestamp?: string; error?: string }>;
  };
};

export type PurchaseCredentials = {
  accountId: string;
  privateKey: string;
  network: "hedera:testnet";
};

function normalizeEndpoint(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function openStore(env: NodeJS.ProcessEnv): BudgetLedger {
  if (env.DATABASE_URL?.trim()) return new PostgresBudgetStore(env.DATABASE_URL.trim());
  const dbPath = env.POLICY_DB_PATH?.trim() || "neverdown-policy.sqlite";
  return new BudgetStore(dbPath);
}

function buildAuditConfig(env: NodeJS.ProcessEnv): ReturnType<typeof loadHcsConfig> {
  return loadHcsConfig(env);
}

function buildPolicy(env: NodeJS.ProcessEnv): PolicyConfig {
  return loadPolicyConfig(env);
}

export function buildPurchaseDeps(env: NodeJS.ProcessEnv = process.env): PurchaseDeps {
  const policy = buildPolicy(env);
  const hcsCfg = buildAuditConfig(env);
  if ((env.HCS_AUDIT_AVAILABILITY?.trim().toUpperCase() || "REQUIRED_DURABLE") === "REQUIRED_DURABLE" && !hcsCfg) {
    throw new Error("HCS topic and operator credentials required for durable payment audit");
  }
  const store = openStore(env);
  if (store instanceof BudgetStore) store.initializePolicy(policy.policyId, 0n);
  let auditClient: any = undefined;
  if (hcsCfg) {
    const client = new HederaHcsClient(hcsCfg);
    auditClient = {
      submit: (event: any) => client.submit(event),
    };
  }
  return {
    policy,
    store,
    audit: { config: hcsCfg },
    auditClient,
    fetchImpl: fetch,
    createHttpClient: undefined,
  };
}

export function loadCredentials(env: NodeJS.ProcessEnv): PurchaseCredentials {
  const spendAccountId = env.HEDERA_SPEND_ID?.trim() || "";
  if (!HEDERA_ACCOUNT_ID.test(spendAccountId)) throw new Error("HEDERA_SPEND_ID invalid");
  const spendPrivateKey = env.HEDERA_SPEND_KEY?.trim();
  if (!spendPrivateKey) throw new Error("HEDERA_SPEND_KEY missing");
  return { accountId: spendAccountId, privateKey: spendPrivateKey, network: "hedera:testnet" };
}


async function anchor(_env: NodeJS.ProcessEnv, deps: PurchaseDeps, id: string, purchaseId: string, policy: PolicyConfig, eventType: string, event: any): Promise<"published" | "failed" | "disabled"> {
  const cfg = deps.audit?.config;
  if (!cfg || !deps.auditClient) {
    return deps.audit?.config ? "failed" : "disabled";
  }
  await deps.store.enqueueOutbox({ id, purchaseId, policyId: policy.policyId, eventType, event, contentHash: hashCanonical(event), status: "pending", createdAt: new Date().toISOString() });
  const result = await deps.auditClient.submit(event);
  if (result.status === "published") await deps.store.markOutboxAnchored(id, result.sequenceNumber, result.consensusTimestamp!);
  else await deps.store.markOutboxFailed(id, result.error ?? "HCS failed");
  return result.status as any;
}


export async function runPurchase(env: NodeJS.ProcessEnv, deps: PurchaseDeps, credentials: PurchaseCredentials, request: PurchaseRequest, fetchImplOverride?: typeof fetch): Promise<PurchaseOutcome> {
  void env;
  const policy = deps.policy;
  const store = deps.store;
  void env;
  const fetchImpl = fetchImplOverride ?? deps.fetchImpl ?? fetch;
  const endpoint = normalizeEndpoint(request.endpoint);
  if (!endpoint) {
    return { status: "DENIED", purchaseId: request.purchaseId, denyReason: "INVALID_ENDPOINT", message: "invalid endpoint", auditStatus: "disabled" };
  }
  if (!policy.allowedEndpoints.includes(endpoint)) {
    return { status: "DENIED", purchaseId: request.purchaseId, denyReason: "ENDPOINT_NOT_APPROVED", message: "endpoint not approved", auditStatus: "disabled" };
  }

  // 1) fetch unpaid challenge
  let challenge: any;
  const purchaseUrl = request.purchaseUrl ?? `${endpoint}/rpc`;
  let resourceUrl = purchaseUrl;
  try {
    const unpaid = await fetchImpl(purchaseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: request.purchaseUrl ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    if (unpaid.status !== 402) throw new Error("invalid challenge");
    const raw = unpaid.headers.get("payment-required");
    if (!raw) throw new Error("missing payment-required header");
    challenge = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    resourceUrl = String((challenge as any)?.resource?.url ?? resourceUrl);
    if (!resourceUrl) throw new Error("missing challenge resource");
    if (resourceUrl !== purchaseUrl) throw new Error("challenge resource differs from selected offer");
    if (request.purchaseUrl) {
      const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
      if (accepts.length !== 1 || accepts[0]?.scheme !== policy.scheme || accepts[0]?.network !== policy.network || accepts[0]?.asset !== policy.asset || String(accepts[0]?.payTo) !== request.expectedPayTo || bigintStr(accepts[0]?.amount) !== request.expectedAmountTinybars) throw new Error("challenge terms differ from selected offer");
    }
    if (new URL(resourceUrl).origin !== new URL(endpoint).origin) throw new Error("origin mismatch");
    if (!policy.allowedEndpoints.includes(normalizeEndpoint(resourceUrl))) {
      // resource must live on an approved endpoint, exact origin
      const resourceOrigin = normalizeEndpoint(new URL(resourceUrl).origin);
      if (!policy.allowedEndpoints.includes(resourceOrigin)) throw new Error("origin not approved");
    }
  } catch (e) {
    return { status: "DENIED", purchaseId: request.purchaseId, denyReason: "CHALLENGE_FAILED", message: e instanceof Error ? e.message : "challenge failed", auditStatus: "disabled" };
  }

  // 2) authorize (budget reserve + auth record)
  const authorizationResult = await authorizePurchase({
    policy,
    paymentRequirements: challenge as any,
    store,
    serviceId: request.serviceId,
    purchaseId: request.purchaseId,
    endpoint,
  });
  if (!authorizationResult.approved) {
    const authAny = authorizationResult as any;
    const denyReason = authAny.denyReason ?? "POLICY_VIOLATION";
    const event = {
      schemaVersion: "nd-audit-v1", eventId: "outbox-".concat(request.purchaseId,"-DENY"), purchaseId: request.purchaseId, policyId: policy.policyId,
      policyVersion: policy.version, eventType: "PURCHASE_DENIED", occurredAt: new Date().toISOString(),
      buyerAccountReference: policy.buyerAccount, sellerPayTo: challenge?.accepts?.[0]?.payTo ?? "", network: policy.network,
      asset: policy.asset, amountTinybars: "0", reasonCode: denyReason, requirementHash: hashCanonical(challenge?.accepts?.[0] ?? {}),
      evidenceHash: hashCanonical({ event: "DENY", challenge }),
    };
    const auditStatus = await anchor(process.env, deps, "outbox-".concat(request.purchaseId,"-DENY"), request.purchaseId, policy, "PURCHASE_DENIED", event);
    return { status: "DENIED", purchaseId: request.purchaseId, denyReason, message: authAny.message ?? denyReason, auditStatus };
  }

  const authorization = authorizationResult.authorization;
  // 3) durable authorization audit (fail closed if required)
  const authId = `outbox-${request.purchaseId}-AUTH`;
  const authEvent = {
    schemaVersion: "nd-audit-v1", eventId: authId, purchaseId: request.purchaseId, policyId: policy.policyId,
    policyVersion: policy.version, eventType: "PURCHASE_AUTHORIZED", occurredAt: new Date().toISOString(),
    buyerAccountReference: policy.buyerAccount, sellerPayTo: authorization.sellerPayTo, network: authorization.network,
    asset: authorization.asset, amountTinybars: authorization.amountTinybars.toString(), reasonCode: "AUTHORIZED",
    requirementHash: authorization.selectedRequirementHash, evidenceHash: hashCanonical(authorization),
  };
  // no env unused placeholder
  const authAuditStatus = await anchor(process.env, deps, authId, request.purchaseId, policy, "PURCHASE_AUTHORIZED", authEvent);
  if ((process.env.HCS_AUDIT_AVAILABILITY?.trim().toUpperCase()||"REQUIRED_DURABLE")==="REQUIRED_DURABLE" && authAuditStatus !== "published" && deps.audit?.config) {
    await store.releaseOnPreSigningFailure(request.purchaseId, "audit failed");
    return { status: "RELEASED", purchaseId: request.purchaseId, denyReason: "AUDIT_UNAVAILABLE", message: "durable authorization audit failed", auditStatus: authAuditStatus } as any;
  }

  // 4) narrowing/check challenge integrity before claim
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  const candidate = accepts.find((r: any) => hashCanonical(r) === authorization.selectedRequirementHash);
  const matching = accepts.filter((r: any) => r?.scheme === authorization.scheme && r?.network === authorization.network && r?.asset === authorization.asset && String(r?.payTo) === authorization.sellerPayTo && bigintStr(r?.amount) === authorization.amountTinybars.toString());
  if (!candidate || matching.length !== 1 || hashCanonical(matching[0]) !== authorization.selectedRequirementHash) {
    await store.releaseOnPreSigningFailure(request.purchaseId, "requirement changed");
    return { status: "RELEASED", purchaseId: request.purchaseId, denyReason: "REQUIREMENT_CHANGED", message: "payment requirements changed", auditStatus: "disabled" } as any;
  }

  // 5) consume reservation right before signing
  try {
    await store.consumeForSigning(request.purchaseId, policy.policyId, authorization.sellerPayTo, authorization.amountTinybars, authorization.expiresAt);
  } catch (e) {
    const le = e as any;
    const code = typeof le?.code === "string" ? le.code : "NOT_RESERVED";
    // always attempt release
    await store.releaseOnPreSigningFailure(request.purchaseId, code);
    return { status: "DENIED", purchaseId: request.purchaseId, denyReason: code, message: le instanceof Error ? le.message : "claim failed", auditStatus: "disabled" };
  }

  // 6) sign and pay
  const httpClient = (deps.createHttpClient ? deps.createHttpClient(credentials) : createHederaX402HttpClient({ accountId: credentials.accountId, privateKey: credentials.privateKey, network: credentials.network, maxPaymentTinybars: policy.maxPerPaymentTinybars.toString() }));
  const sellerUrl = endpoint;
  let result: any;
  try {
    result = request.purchaseUrl
      ? await payForRpcPack({ purchaseUrl, httpClient, fetchImpl, expectedChallenge: challenge })
      : await payForRpcOnce({ sellerUrl, httpClient, fetchImpl });
  } catch (e) {
    await store.markUncertain(request.purchaseId, e instanceof Error ? e.message : "unknown");
    const uncertainId = `outbox-${request.purchaseId}-UNCERTAIN`;
    const event = {
      schemaVersion: "nd-audit-v1", eventId: uncertainId, purchaseId: request.purchaseId, policyId: policy.policyId,
      policyVersion: policy.version, eventType: "PAYMENT_UNCERTAIN", occurredAt: new Date().toISOString(),
      buyerAccountReference: policy.buyerAccount, sellerPayTo: authorization.sellerPayTo, network: authorization.network,
      asset: authorization.asset, amountTinybars: authorization.amountTinybars.toString(), reasonCode: "UNCERTAIN",
      requirementHash: authorization.selectedRequirementHash, evidenceHash: hashCanonical({ error: e instanceof Error ? e.message : "unknown" }),
    };
    const as = await anchor(process.env, deps, uncertainId, request.purchaseId, policy, "PAYMENT_UNCERTAIN", event);
    return { status: "UNCERTAIN", purchaseId: request.purchaseId, denyReason: "PAYMENT_UNCERTAIN", message: e instanceof Error ? e.message : "payment failed", auditStatus: as } as any;
  }

  // 7) settle
  await store.setTransaction(request.purchaseId, result.transactionId);
  const settled = await store.markSettled(request.purchaseId, result.transactionId);
  if (!settled) {
    // concurrency edge
  }
  const settleId = `outbox-${request.purchaseId}-SETTLED`;
  const settleEvent = {
    schemaVersion: "nd-audit-v1", eventId: settleId, purchaseId: request.purchaseId, policyId: policy.policyId,
    policyVersion: policy.version, eventType: "PAYMENT_SETTLED", occurredAt: new Date().toISOString(),
    buyerAccountReference: policy.buyerAccount, sellerPayTo: authorization.sellerPayTo, network: authorization.network,
    asset: authorization.asset, amountTinybars: authorization.amountTinybars.toString(), reasonCode: "SETTLED",
    requirementHash: authorization.selectedRequirementHash, evidenceHash: hashCanonical(result),
    settlementTransactionId: result.transactionId,
  };
  const settleAudit = await anchor(process.env, deps, settleId, request.purchaseId, policy, "PAYMENT_SETTLED", settleEvent);
  return {
    status: "SETTLED",
    purchaseId: request.purchaseId,
    transactionId: result.transactionId,
    hashscanUrl: result.hashscanUrl,
    rpcResult: result.rpcResult,
    ...(request.purchaseUrl ? { entitlementToken: result.entitlementToken } : {}),
    httpStatus: result.httpStatus,
    auditStatus: settleAudit,
  };
}

function bigintStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  return "";
}

