/** Restricted server-side facade over @neverdown/core. */
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
export { NeverDown } from "./client.js";
export type { NeverDownOptions, ProcureInput, ProcureReceipt } from "./client.js";
export { FailureSpotMonitor } from "./monitor.js";
export type { FailureIncident, FailureSpot } from "./monitor.js";
