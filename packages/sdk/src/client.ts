import {
  discoverOffers,
  loadArkivReadConfig,
  proofOfCapability,
  requireEnsAllowed,
  resolveAndValidateEnsSeller,
  type CapabilityOfferRow,
  type DiscoverOffersInput,
  type ProofOfCapabilityInput,
} from "@neverdown/core";

type ReadPorts = {
  resolve: typeof resolveAndValidateEnsSeller;
  discover: typeof discoverOffers;
  prove: typeof proofOfCapability;
};

export type NeverDownOptions = { env?: NodeJS.ProcessEnv };

const forbidden = ["HEDERA_SPEND_KEY", "HEDERA_OPERATOR_KEY", "ARKIV_PRIVATE_KEY", "RECLAIM_PRIVATE_KEY"];

export class NeverDown {
  private readonly env: NodeJS.ProcessEnv;
  private readonly allowlist: string[];

  constructor(options: NeverDownOptions, private readonly ports: ReadPorts = {
    resolve: resolveAndValidateEnsSeller,
    discover: discoverOffers,
    prove: proofOfCapability,
  }) {
    const input = options.env ?? process.env;
    for (const key of forbidden) {
      if (Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`${key} must stay in the payment worker env file`);
    }
    const rpc = input.ENS_RPC_URL?.trim();
    if (!rpc) throw new Error("ENS_RPC_URL is required");
    const rpcUrl = new URL(rpc);
    if (rpcUrl.protocol !== "https:") throw new Error("ENS_RPC_URL must use HTTPS");
    this.allowlist = (input.ENS_ALLOWLIST_NAMES ?? "").split(/[,\s;]+/).map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (this.allowlist.length === 0) throw new Error("ENS_ALLOWLIST_NAMES is required");
    // Copy only read-side settings; never retain an arbitrary caller environment.
    this.env = {
      ENS_RPC_URL: rpc,
      ENS_ALLOWLIST_NAMES: this.allowlist.join(","),
      POC_REFERENCE_RPC: input.POC_REFERENCE_RPC?.trim(),
      ARKIV_ACCESS_KEY: input.ARKIV_ACCESS_KEY?.trim(),
      ARKIV_CHAIN_ID: input.ARKIV_CHAIN_ID?.trim(),
      ARKIV_RPC: input.ARKIV_RPC?.trim(),
      PAYMENT_WORKER_ENV_FILE: input.PAYMENT_WORKER_ENV_FILE?.trim(),
    };
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
    return this.ports.prove({ ...input, referenceRpcUrl });
  }
}

/** Internal test seam; excluded from the package's public exports. */
export function createNeverDownClient(options: NeverDownOptions, ports: ReadPorts): NeverDown {
  return new NeverDown(options, ports);
}
