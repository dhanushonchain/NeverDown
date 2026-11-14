/**
 * @neverdown/sdk — server-side Resilience Contract client.
 *
 * Preferred API: `NeverDown`, `FailureSpotMonitor`, and the types below.
 * Advanced re-exports from `@neverdown/core` are escape hatches for tests and
 * custom wiring — prefer the class methods in application code.
 */
export { NeverDown } from "./client.js";
export type { NeverDownOptions, ProcureInput, ProcureReceipt } from "./client.js";
export { FailureSpotMonitor } from "./monitor.js";
export type { FailureIncident, FailureSpot } from "./monitor.js";
export { assertNeverDownHostEnv, FORBIDDEN_HOST_KEYS } from "./env.js";
export type { AssertNeverDownHostEnvResult, NeverDownHostEnv } from "./env.js";

/** @advanced Escape hatches — prefer `NeverDown` methods in app code. */
export {
  resolveEnsSeller,
  resolveAndValidateEnsSeller,
  requireEnsAllowed,
  validateResolvedSeller,
  discoverOffers,
  proofOfCapability,
  loadPolicyConfig,
  startPaymentWorker,
} from "@neverdown/core";
export type {
  EnsSellerResolution,
  EnsTextRecords,
  DiscoverOffersInput,
  ProofOfCapabilityInput,
  ProofOfCapabilityResult,
  PurchaseRequest,
  PaymentWorkerHandle,
  PolicyConfig,
  CapabilityOfferRow,
} from "@neverdown/core";
