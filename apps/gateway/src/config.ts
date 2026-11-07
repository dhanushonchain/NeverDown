export interface GatewayProviderConfig { id: string; url: string; }

export interface GatewayConfig {
  port: number;
  chainId: number;
  providers: GatewayProviderConfig[];
  healthIntervalMs: number;
  requestTimeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  staleBlockTolerance: number;
  failoverCooldownMs: number;
  internalApiEnabled: boolean;
  internalToken?: string;
  rpcToken?: string;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function reqUrl(env: NodeJS.ProcessEnv, primary: string, alias: string): string {
  const raw = (env[primary] ?? env[alias] ?? "").trim();
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigError(`${primary} (${alias}) must be a valid URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${primary} (${alias}) must use http or https`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${primary} (${alias}) must not contain credentials`);
  }
  return (url as URL).toString();
}

function hasUnique(urls: string[]): boolean {
  return new Set(urls).size === urls.length;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = intEnv(env, "GATEWAY_PORT", 8787, 1, 65535);
  const chainId = intEnv(env, "GATEWAY_CHAIN_ID", 11155111, 1, 2_147_483_647);
  const primaryUrl = reqUrl(env, "GATEWAY_PRIMARY_RPC_URL", "GATEWAY_PRIMARY_RPC");
  const standbyUrl = reqUrl(env, "GATEWAY_STANDBY_RPC_URL", "GATEWAY_STANDBY_RPC");

  if (!primaryUrl && !standbyUrl) {
    throw new ConfigError("At least one of GATEWAY_PRIMARY_RPC or GATEWAY_STANDBY_RPC_URL must be configured");
  }

  const urls = [primaryUrl, standbyUrl].filter(Boolean);
  if (!hasUnique(urls)) {
    throw new ConfigError("Primary and standby RPC URLs must be independently configured (not identical)");
  }

  const providers: GatewayProviderConfig[] = [
    ...(primaryUrl ? [{ id: "primary", url: primaryUrl } satisfies GatewayProviderConfig] : []),
    ...(standbyUrl ? [{ id: "standby", url: standbyUrl } satisfies GatewayProviderConfig] : []),
  ];

  return {
    port,
    chainId,
    providers,
    healthIntervalMs: intEnv(env, "GATEWAY_HEALTH_INTERVAL_MS", 5000, 500, 60_000),
    requestTimeoutMs: intEnv(env, "GATEWAY_REQUEST_TIMEOUT_MS", 3000, 500, 60_000),
    failureThreshold: intEnv(env, "GATEWAY_FAILURE_THRESHOLD", 3, 1, 10),
    recoveryThreshold: intEnv(env, "GATEWAY_RECOVERY_THRESHOLD", 3, 1, 10),
    staleBlockTolerance: intEnv(env, "GATEWAY_STALE_BLOCK_TOLERANCE", 20, 0, 100_000),
    failoverCooldownMs: intEnv(env, "GATEWAY_FAILOVER_COOLDOWN_MS", 15000, 0, 300_000),
    internalApiEnabled: (env.GATEWAY_INTERNAL_API ?? "").trim().toLowerCase() === "true",
    internalToken: (env.GATEWAY_INTERNAL_TOKEN ?? "").trim() || undefined,
    rpcToken: (env.GATEWAY_RPC_TOKEN ?? "").trim() || undefined,
  };
}
