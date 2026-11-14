/** Host-process env for NeverDown.create — never put spend keys here. */
export type NeverDownHostEnv = {
  ENS_RPC_URL?: string;
  ENS_ALLOWLIST_NAMES?: string;
  POC_REFERENCE_RPC?: string;
  ARKIV_ACCESS_KEY?: string;
  ARKIV_CHAIN_ID?: string;
  ARKIV_RPC?: string;
  PAYMENT_WORKER_ENV_FILE?: string;
  GATEWAY_URL?: string;
  GATEWAY_INTERNAL_TOKEN?: string;
};

export const FORBIDDEN_HOST_KEYS = [
  "HEDERA_SPEND_KEY",
  "HEDERA_OPERATOR_KEY",
  "ARKIV_PRIVATE_KEY",
  "RECLAIM_PRIVATE_KEY",
] as const;

export type AssertNeverDownHostEnvResult = {
  allowlist: string[];
  ensRpcUrl: string;
  hostEnv: NeverDownHostEnv;
};

/**
 * Validates the SDK host environment (fail closed).
 * Lists every problem in one error when multiple fields are wrong.
 */
export function assertNeverDownHostEnv(input: NodeJS.ProcessEnv = process.env): AssertNeverDownHostEnvResult {
  const problems: string[] = [];

  for (const key of FORBIDDEN_HOST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      problems.push(`${key} must stay in the payment worker env file`);
    }
  }

  const rpc = input.ENS_RPC_URL?.trim();
  if (!rpc) problems.push("ENS_RPC_URL is required");
  else {
    try {
      const rpcUrl = new URL(rpc);
      if (rpcUrl.protocol !== "https:") problems.push("ENS_RPC_URL must use HTTPS");
    } catch {
      problems.push("ENS_RPC_URL must be a valid HTTPS URL");
    }
  }

  const allowlist = (input.ENS_ALLOWLIST_NAMES ?? "")
    .split(/[,\s;]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) problems.push("ENS_ALLOWLIST_NAMES is required (comma-separated ENS names)");

  if (problems.length > 0) {
    throw new Error(`NeverDown host env invalid:\n- ${problems.join("\n- ")}`);
  }

  return {
    allowlist,
    ensRpcUrl: rpc!,
    hostEnv: {
      ENS_RPC_URL: rpc!,
      ENS_ALLOWLIST_NAMES: allowlist.join(","),
      POC_REFERENCE_RPC: input.POC_REFERENCE_RPC?.trim(),
      ARKIV_ACCESS_KEY: input.ARKIV_ACCESS_KEY?.trim(),
      ARKIV_CHAIN_ID: input.ARKIV_CHAIN_ID?.trim(),
      ARKIV_RPC: input.ARKIV_RPC?.trim(),
      PAYMENT_WORKER_ENV_FILE: input.PAYMENT_WORKER_ENV_FILE?.trim(),
      GATEWAY_URL: input.GATEWAY_URL?.trim(),
      GATEWAY_INTERNAL_TOKEN: input.GATEWAY_INTERNAL_TOKEN?.trim(),
    },
  };
}
