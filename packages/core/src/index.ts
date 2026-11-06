export const NEVERDOWN_VERSION = "0.0.0";
export function neverdownIdentity(): string { return "NeverDown"; }

// Restricted agent-facing surface:
// - policy config and evidence helpers only
// - explicit payment boundary via payment worker (requestPurchase)
export { loadEnsConfig, resolveEnsSeller, requireEnsAllowed, validateResolvedSeller, resolveAndValidateEnsSeller } from "./ens/index.js";
export type { EnsTextRecords, EnsSellerResolution, EnsConfig } from "./ens/index.js";

export { proofOfCapability, normalizeChainId, jsonRpcCall } from "./poc/index.js";
export type { ProofOfCapabilityInput, ProofOfCapabilityResult } from "./poc/index.js";

export { discoverOffers, filterOffers } from "./arkiv/discover.js";
export type { DiscoverOffersInput } from "./arkiv/discover.js";
export { loadArkivReadConfig } from "./arkiv/config.js";
export type { CapabilityOfferRow } from "./arkiv/schema.js";

export { normalizeEndpoint } from "./policy/endpoint.js";
export { hashCanonical, canonicalize } from "./hcs/evidence.js";
export { startPaymentWorker, type PaymentWorkerHandle, type PurchaseRequest } from "./payment-worker/index.js";
export { loadPolicyConfig, PolicyConfigError } from "./policy/config.js";
export type { PolicyConfig } from "./policy/types.js";

// C8 supreme agent (deep imports still preferred for demos/scripts)
export {
  createHermeticToolBelt,
  createLiveToolBelt,
  runAgentScenario,
} from "./agent/index.js";
export type { AgentScenario, AgentToolBelt, EvidenceReceipt } from "./agent/index.js";
