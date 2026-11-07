export type RpcMode = "mock" | "upstream";

export interface SellerConfig {
  port: number;
  network: "hedera:testnet";
  merchantAccountId: string;
  assetId: string;
  priceSmallestUnits: string;
  facilitatorUrl: string;
  rpcMode: RpcMode;
  rpcUpstreamUrl: string | null;
  entitlementDbPath: string;
  databaseUrl: string | null;
  trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HEDERA_ACCOUNT_ID = /^0\.0\.[1-9]\d*$/;
const HEDERA_ASSET_ID = /^0\.0\.(0|[1-9]\d*)$/;
const POSITIVE_INT = /^[1-9]\d{0,17}$/;
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function parseHttpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ConfigError(`${name} must use https (http is allowed only for localhost)`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain credentials`);
  }
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SellerConfig {
  const portRaw = env.PORT?.trim() || env.SELLER_PORT?.trim() || "4001";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT or SELLER_PORT must be an integer between 1 and 65535");
  }

  const network = env.HEDERA_NETWORK?.trim() || "testnet";
  if (network !== "testnet") {
    throw new ConfigError("HEDERA_NETWORK must be 'testnet' (mainnet is out of scope for C1)");
  }

  const merchantAccountId = requireValue(env, "HEDERA_MERCHANT_ACCOUNT_ID");
  if (!HEDERA_ACCOUNT_ID.test(merchantAccountId)) {
    throw new ConfigError("HEDERA_MERCHANT_ACCOUNT_ID must look like 0.0.12345");
  }

  const assetId = env.HEDERA_X402_ASSET_ID?.trim() || "0.0.0";
  if (!HEDERA_ASSET_ID.test(assetId)) {
    throw new ConfigError("HEDERA_X402_ASSET_ID must look like 0.0.0 (HBAR) or an HTS token id");
  }

  const priceSmallestUnits = env.HEDERA_X402_PRICE_SMALLEST_UNITS?.trim() || "10000";
  if (!POSITIVE_INT.test(priceSmallestUnits)) {
    throw new ConfigError("HEDERA_X402_PRICE_SMALLEST_UNITS must be a positive integer");
  }

  const facilitatorUrl = parseHttpUrl(
    "X402_FACILITATOR_URL",
    env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL,
  );

  const rpcMode = env.RPC_MODE?.trim() || "mock";
  if (rpcMode !== "mock" && rpcMode !== "upstream") {
    throw new ConfigError("RPC_MODE must be 'mock' or 'upstream'");
  }

  let rpcUpstreamUrl: string | null = null;
  if (rpcMode === "upstream") {
    rpcUpstreamUrl = parseHttpUrl("RPC_UPSTREAM_URL", requireValue(env, "RPC_UPSTREAM_URL"));
  }

  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (env.DYNO && !databaseUrl) throw new ConfigError("DATABASE_URL is required on Heroku; local SQLite is not durable there");
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch { throw new ConfigError("DATABASE_URL must be a PostgreSQL URL"); }
  }

  return {
    port,
    network: "hedera:testnet",
    merchantAccountId,
    assetId,
    priceSmallestUnits,
    facilitatorUrl,
    rpcMode,
    rpcUpstreamUrl,
    entitlementDbPath: env.SELLER_ENTITLEMENT_DB_PATH?.trim() || "neverdown-seller.sqlite",
    databaseUrl,
    trustProxy: Boolean(env.DYNO),
  };
}
