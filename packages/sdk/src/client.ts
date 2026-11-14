import {
  discoverOffers,
  loadArkivReadConfig,
  proofOfCapability,
  requireEnsAllowed,
  resolveAndValidateEnsSeller,
  startPaymentWorker,
  type CapabilityOfferRow,
  type DiscoverOffersInput,
  type ProofOfCapabilityInput,
} from "@neverdown/core";
import { assertNeverDownHostEnv } from "./env.js";

type ReadPorts = {
  resolve: typeof resolveAndValidateEnsSeller;
  discover: typeof discoverOffers;
  prove: typeof proofOfCapability;
  worker?: typeof startPaymentWorker;
  fetchImpl?: typeof fetch;
};

export type NeverDownOptions = { env?: NodeJS.ProcessEnv };

export type ProcureInput = { incidentId: string; serviceId: string; offer: CapabilityOfferRow };
export type ProcureReceipt = {
  status: "SETTLED" | "DENIED" | "RELEASED" | "UNCERTAIN";
  installed: boolean;
  purchaseId: string;
  transactionId?: string;
  hashscanUrl?: string;
  auditStatus?: "disabled" | "published" | "failed";
  denyReason?: string;
  installError?: string;
};

export class NeverDown {
  private readonly env: NodeJS.ProcessEnv;
  private readonly allowlist: string[];

  constructor(options: NeverDownOptions, private readonly ports: ReadPorts = {
    resolve: resolveAndValidateEnsSeller,
    discover: discoverOffers,
    prove: proofOfCapability,
  }) {
    const checked = assertNeverDownHostEnv(options.env ?? process.env);
    this.allowlist = checked.allowlist;
    // Copy only read-side settings; never retain an arbitrary caller environment.
    this.env = { ...checked.hostEnv };
  }

  static create(options: NeverDownOptions = {}): NeverDown { return new NeverDown(options); }

  async resolveSeller(input: { ensName: string; expectedPayTo: string }) {
    requireEnsAllowed(input.ensName, this.allowlist);
    return this.ports.resolve(input.ensName, input.expectedPayTo, this.env.ENS_RPC_URL!, this.allowlist);
  }

  async discoverOffers(input: Omit<DiscoverOffersInput, "config">): Promise<CapabilityOfferRow[]> {
    const offers = await this.ports.discover({ ...input, config: loadArkivReadConfig(this.env) });
    const allowed = new Set(this.allowlist);
    return offers.filter((offer) => allowed.has(offer.sellerens.toLowerCase()))
      .sort((a, b) => (a.pricetinybars < b.pricetinybars ? -1 : a.pricetinybars > b.pricetinybars ? 1 : 0));
  }

  async proveCapability(input: Omit<ProofOfCapabilityInput, "referenceRpcUrl">) {
    const referenceRpcUrl = this.env.POC_REFERENCE_RPC;
    if (!referenceRpcUrl) throw new Error("POC_REFERENCE_RPC is required for an independent proof");
    if (referenceRpcUrl === input.rpcUrl) throw new Error("POC_REFERENCE_RPC must differ from candidate URL");
    const boundedFetch: typeof fetch = (resource, init) => fetch(resource, { ...init, signal: init?.signal ?? AbortSignal.timeout(6000) });
    return this.ports.prove({ ...input, referenceRpcUrl, fetchImpl: input.fetchImpl ?? boundedFetch });
  }

  async procure(input: ProcureInput): Promise<ProcureReceipt> {
    const { offer } = input;
    if (offer.category !== "rpc" || offer.schemaversion !== 2n || offer.expiresat === undefined || Date.parse(offer.expiresat) <= Date.now()) {
      throw new Error("unsupported or expired offer");
    }
    requireEnsAllowed(offer.sellerens, this.allowlist);
    const offers = await this.discoverOffers({ category: offer.category, maxPriceTinybars: offer.pricetinybars, allowedPayTo: [offer.payto] });
    if (!offers.some((row) => row.entityKey === offer.entityKey && row.serviceurl === offer.serviceurl && row.purchaseurl === offer.purchaseurl && row.probeurl === offer.probeurl && row.rpcurl === offer.rpcurl && row.payto === offer.payto && row.pricetinybars === offer.pricetinybars && row.chainid === offer.chainid)) {
      throw new Error("offer is not a current matching Arkiv entity");
    }
    const seller = await this.resolveSeller({ ensName: offer.sellerens, expectedPayTo: offer.payto });
    const service = new URL(offer.serviceurl);
    if (service.origin !== offer.serviceurl || (service.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(service.hostname))) throw new Error("invalid offer endpoint");
    if (seller.records.x402Url?.replace(/\/+$/, "") !== offer.serviceurl) throw new Error("ENS endpoint differs from offer endpoint");
    if (offer.purchaseurl !== `${offer.serviceurl}/rpc-pack` || offer.probeurl !== `${offer.serviceurl}/probe` || offer.rpcurl !== `${offer.serviceurl}/rpc`) throw new Error("offer URLs differ from verified endpoint");
    const proof = await this.proveCapability({ rpcUrl: offer.probeurl, expectedChainId: Number(offer.chainid), payTo: offer.payto, ensPayTo: seller.records.hederaAccount! });
    if (!proof.pass) throw new Error("capability proof failed");

    const workerFile = this.env.PAYMENT_WORKER_ENV_FILE;
    if (!workerFile) throw new Error("PAYMENT_WORKER_ENV_FILE is required");
    const gatewayUrl = this.env.GATEWAY_URL?.replace(/\/+$/, "");
    const gatewayToken = this.env.GATEWAY_INTERNAL_TOKEN;
    if (!gatewayUrl || !gatewayToken || gatewayToken.length < 20) throw new Error("GATEWAY_URL and GATEWAY_INTERNAL_TOKEN are required before payment");
    let gatewayReady: Response;
    try {
      gatewayReady = await (this.ports.fetchImpl ?? fetch)(`${gatewayUrl}/_internal/ready`, {
        method: "GET",
        headers: { "x-gateway-internal-token": gatewayToken },
        signal: AbortSignal.timeout(5000),
      });
    } catch { throw new Error("gateway install API unavailable before payment"); }
    if (!gatewayReady.ok || (await gatewayReady.json() as { ready?: unknown }).ready !== true) throw new Error("gateway install API unavailable before payment");
    const worker = (this.ports.worker ?? startPaymentWorker)({ envFile: workerFile, timeoutMs: 120_000 });
    let outcome: Record<string, unknown>;
    try {
      outcome = await worker.requestPurchase({
        purchaseId: input.incidentId,
        serviceId: input.serviceId,
        endpoint: offer.serviceurl,
        purchaseUrl: offer.purchaseurl,
        expectedPayTo: offer.payto,
        expectedAmountTinybars: offer.pricetinybars.toString(),
        offerEntityKey: offer.entityKey,
      });
    } catch {
      return { status: "UNCERTAIN", installed: false, purchaseId: input.incidentId, denyReason: "WORKER_UNAVAILABLE" };
    } finally { worker.close(); }
    const status = outcome.status as ProcureReceipt["status"];
    const receipt: ProcureReceipt = {
      status,
      installed: false,
      purchaseId: input.incidentId,
      ...(typeof outcome.auditStatus === "string" ? { auditStatus: outcome.auditStatus as ProcureReceipt["auditStatus"] } : {}),
    };
    if (status !== "SETTLED") {
      if (typeof outcome.denyReason === "string") receipt.denyReason = outcome.denyReason;
      return receipt;
    }
    if (typeof outcome.transactionId === "string") receipt.transactionId = outcome.transactionId;
    if (typeof outcome.hashscanUrl === "string") receipt.hashscanUrl = outcome.hashscanUrl;
    if (typeof outcome.entitlementToken !== "string" || !receipt.transactionId) {
      receipt.installError = "settled purchase missing transaction or entitlement; reconcile before retry";
      return receipt;
    }
    try {
      const response = await (this.ports.fetchImpl ?? fetch)(`${gatewayUrl}/_internal/install-standby`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-internal-token": gatewayToken },
        body: JSON.stringify({ url: offer.rpcurl, probeUrl: offer.probeurl, entitlementToken: outcome.entitlementToken }),
        signal: AbortSignal.timeout(8000),
      });
      receipt.installed = response.ok;
      if (!response.ok) receipt.installError = `gateway HTTP ${response.status}`;
    } catch {
      receipt.installError = "gateway installation unavailable";
    }
    return receipt;
  }
}

/** Internal test seam; excluded from the package's public exports. */
export function createNeverDownClient(options: NeverDownOptions, ports: ReadPorts): NeverDown {
  return new NeverDown(options, ports);
}
