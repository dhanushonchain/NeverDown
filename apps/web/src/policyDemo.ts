import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PolicyDemoStep = {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  adds: string;
};

export type PolicyDemoInput = {
  allowlist: string[];
  maxPaymentTinybars: bigint;
  totalBudgetTinybars: bigint;
  alreadySpentTinybars: bigint;
  mode: "deny-recipient" | "deny-budget" | "approve";
  sellerUrl?: string;
};

export type PolicyDemoResult = {
  approved: boolean;
  denyReason?: string;
  verdict: string;
  attempt: {
    payTo: string;
    amountTinybars: string;
    serviceId: string;
    endpoint: string;
  };
  policy: {
    allowlist: string[];
    maxPaymentTinybars: string;
    totalBudgetTinybars: string;
    alreadySpentTinybars: string;
    remainingTinybars: string;
  };
  steps: PolicyDemoStep[];
  signed: false;
};

function parseAllowlist(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  return text
    .split(/[,\s;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseTinybars(raw: unknown, fallback: bigint): bigint {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  return BigInt(text);
}

export function readLiveSpent(root: string, env: NodeJS.ProcessEnv = process.env): bigint {
  const dbPath = resolve(root, env.POLICY_DB_PATH?.trim() || "neverdown-policy.sqlite");
  if (!existsSync(dbPath)) return 0n;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount_tinybars AS INTEGER)), 0) AS total FROM purchase_reservations WHERE state IN ('RESERVED','SETTLED','UNCERTAIN')",
      )
      .get() as { total: number | string } | undefined;
    db.close();
    return BigInt(row?.total ?? 0);
  } catch {
    return 0n;
  }
}

export function policySnapshot(env: NodeJS.ProcessEnv = process.env, root = process.cwd()) {
  const allowlist = parseAllowlist(env.POLICY_ALLOWLIST || env.HEDERA_MERCHANT_ACCOUNT_ID || "0.0.11326899");
  const maxPaymentTinybars = parseTinybars(env.POLICY_MAX_PER_PAYMENT_TINYBARS || env.HEDERA_X402_PRICE_SMALLEST_UNITS, 10000n);
  const totalBudgetTinybars = parseTinybars(env.POLICY_TOTAL_BUDGET_TINYBARS || env.POLICY_CAP_TINYBARS, 500000n);
  const alreadySpentTinybars = readLiveSpent(root, env);
  return {
    allowlist,
    maxPaymentTinybars: maxPaymentTinybars.toString(),
    totalBudgetTinybars: totalBudgetTinybars.toString(),
    alreadySpentTinybars: alreadySpentTinybars.toString(),
    remainingTinybars: (totalBudgetTinybars > alreadySpentTinybars ? totalBudgetTinybars - alreadySpentTinybars : 0n).toString(),
    endpoints: parseAllowlist(env.POLICY_ENDPOINTS || env.SELLER_URL || ""),
    ens: env.SELLER_ENS_NAME || "neverdownseller.eth",
    note: "Resilience Contract bounds: allowlist + per-payment cap + cumulative budget. Deny before sign.",
  };
}

export function runPolicyDemo(input: PolicyDemoInput): PolicyDemoResult {
  const approvedSeller = input.allowlist[0] || "0.0.11326899";
  const endpoint = (input.sellerUrl || "https://neverdown-seller.example").replace(/\/+$/, "");
  const amount = input.maxPaymentTinybars > 0n ? input.maxPaymentTinybars : 10000n;

  let payTo = approvedSeller;
  const amountTinybars = amount;
  if (input.mode === "deny-recipient") payTo = "0.0.99999999";

  const steps: PolicyDemoStep[] = [];
  const remaining = input.totalBudgetTinybars > input.alreadySpentTinybars
    ? input.totalBudgetTinybars - input.alreadySpentTinybars
    : 0n;

  steps.push({
    id: "intent",
    title: "Purchase intent",
    ok: true,
    detail: `Pay ${amountTinybars.toString()} tinybars to ${payTo} for neverdown-rpc-pack`,
    adds: "Same shape as a real x402 challenge the worker would see",
  });

  const allowOk = input.allowlist.includes(payTo);
  steps.push({
    id: "allowlist",
    title: "Allowlist check",
    ok: allowOk,
    detail: allowOk
      ? `${payTo} is an approved seller`
      : `${payTo} is NOT in [${input.allowlist.join(", ") || "(empty)"}]`,
    adds: "Blocks paying a spoofed Hedera account",
  });
  if (!allowOk) {
    return finish(false, "RECIPIENT_NOT_ALLOWLISTED", steps, payTo, amountTinybars, endpoint, input, remaining);
  }

  const capOk = amountTinybars <= input.maxPaymentTinybars;
  steps.push({
    id: "cap",
    title: "Per-payment cap",
    ok: capOk,
    detail: capOk
      ? `${amountTinybars.toString()} ≤ max ${input.maxPaymentTinybars.toString()}`
      : `${amountTinybars.toString()} exceeds max ${input.maxPaymentTinybars.toString()}`,
    adds: "Stops a single oversized settlement",
  });
  if (!capOk) {
    return finish(false, "OVER_PER_PAYMENT_CAP", steps, payTo, amountTinybars, endpoint, input, remaining);
  }

  let effectiveSpent = input.alreadySpentTinybars;
  if (input.mode === "deny-budget" && effectiveSpent + amountTinybars <= input.totalBudgetTinybars) {
    // Demo attack: show the budget gate even when headroom remains on the live ledger.
    effectiveSpent = input.totalBudgetTinybars;
  }
  const budgetOk = effectiveSpent + amountTinybars <= input.totalBudgetTinybars;
  steps.push({
    id: "budget",
    title: "Cumulative budget",
    ok: budgetOk,
    detail: budgetOk
      ? `spent ${effectiveSpent.toString()} + ${amountTinybars.toString()} ≤ budget ${input.totalBudgetTinybars.toString()}`
      : `spent ${effectiveSpent.toString()} + ${amountTinybars.toString()} > budget ${input.totalBudgetTinybars.toString()}${
          input.mode === "deny-budget" ? " (demo: budget treated as exhausted)" : ""
        }`,
    adds: "Hard stop before any Hedera signature",
  });
  if (!budgetOk) {
    return finish(false, "BUDGET_EXCEEDED", steps, payTo, amountTinybars, endpoint, input, remaining);
  }

  steps.push({
    id: "sign",
    title: "Authorize settlement",
    ok: true,
    detail: "Policy would approve — payment worker may sign + HCS audit",
    adds: "Only now could HBAR move; Act 3/4 run the full agent path",
  });
  return finish(true, undefined, steps, payTo, amountTinybars, endpoint, input, remaining);
}

function finish(
  approved: boolean,
  denyReason: string | undefined,
  steps: PolicyDemoStep[],
  payTo: string,
  amountTinybars: bigint,
  endpoint: string,
  input: PolicyDemoInput,
  remaining: bigint,
): PolicyDemoResult {
  if (!approved) {
    steps.push({
      id: "nosign",
      title: "Refuse before sign",
      ok: true,
      detail: `DENIED · ${denyReason} · no Hedera transaction`,
      adds: "This is the Resilience Contract working — fail closed",
    });
  }
  return {
    approved,
    denyReason,
    verdict: approved
      ? "APPROVED · policy would allow this purchase (demo only — no spend)"
      : `DENIED · ${denyReason} · nothing signed`,
    attempt: {
      payTo,
      amountTinybars: amountTinybars.toString(),
      serviceId: "neverdown-rpc-pack",
      endpoint,
    },
    policy: {
      allowlist: input.allowlist,
      maxPaymentTinybars: input.maxPaymentTinybars.toString(),
      totalBudgetTinybars: input.totalBudgetTinybars.toString(),
      alreadySpentTinybars: input.alreadySpentTinybars.toString(),
      remainingTinybars: remaining.toString(),
    },
    steps,
    signed: false,
  };
}

export function parsePolicyDemoBody(body: Record<string, unknown>, env: NodeJS.ProcessEnv, root: string): PolicyDemoInput {
  const snap = policySnapshot(env, root);
  const modeRaw = String(body.mode || "deny-recipient");
  const mode =
    modeRaw === "deny-budget" || modeRaw === "approve" || modeRaw === "deny-recipient"
      ? modeRaw
      : "deny-recipient";
  return {
    allowlist: parseAllowlist(body.allowlist ?? snap.allowlist),
    maxPaymentTinybars: parseTinybars(body.maxPaymentTinybars, BigInt(snap.maxPaymentTinybars)),
    totalBudgetTinybars: parseTinybars(body.totalBudgetTinybars, BigInt(snap.totalBudgetTinybars)),
    alreadySpentTinybars: parseTinybars(body.alreadySpentTinybars, BigInt(snap.alreadySpentTinybars)),
    mode,
    sellerUrl: String(body.sellerUrl || env.SELLER_URL || snap.endpoints[0] || ""),
  };
}
