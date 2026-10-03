import {
  X402PaymentVerifier,
  type NetworkV2,
  type PaymentPayloadV2,
  type PaymentRequirementsV2,
  type SettlementResponseV2,
  type VerifyResponseV2
} from "x402-stacks";
import {
  AIBTC_RELAY_URL,
  assetId,
  fromCAIP2,
  toCAIP2,
  type StacksNetworkName,
  type TokenSymbol
} from "./constants";

export interface Facilitator {
  verify(
    payload: PaymentPayloadV2,
    requirements: PaymentRequirementsV2
  ): Promise<VerifyResponseV2>;
  settle(
    payload: PaymentPayloadV2,
    requirements: PaymentRequirementsV2
  ): Promise<SettlementResponseV2>;
}

/** Facilitator backed by x402-stacks' verifier (POST /verify, /settle). */
export function httpFacilitator(url: string): Facilitator {
  const verifier = new X402PaymentVerifier(url);
  return {
    verify: (payload, paymentRequirements) =>
      verifier.verify(payload, { paymentRequirements }),
    settle: (payload, paymentRequirements) =>
      verifier.settle(payload, { paymentRequirements })
  };
}

export type StacksPaymentConfig = {
  /** "mainnet" | "testnet" or CAIP-2 ("stacks:1", "stacks:2147483648"). */
  network: StacksNetworkName | NetworkV2;
  /** Stacks address that receives payments. */
  recipient: string;
  /** Token to charge in. Defaults to sBTC. */
  token?: TokenSymbol;
  /** Facilitator URL or implementation. Defaults to the aibtc relay. */
  facilitator?: string | Facilitator;
  /** Seconds the payer has to settle. Defaults to 300. */
  maxTimeoutSeconds?: number;
  /**
   * When to settle. "after-success" (default, same as Cloudflare's
   * agents/x402) only charges if the tool succeeds. "before-run" charges
   * first: use it for expensive tools, because the aibtc relay's /verify does
   * not check the payer's balance, so an unfunded payer can trigger a run
   * whose settlement then fails.
   */
  settle?: "after-success" | "before-run";
};

export type ResolvedServerConfig = {
  network: NetworkV2;
  networkName: StacksNetworkName;
  recipient: string;
  asset: string;
  facilitator: Facilitator;
  maxTimeoutSeconds: number;
  settle: "after-success" | "before-run";
};

export function resolveServerConfig(
  cfg: StacksPaymentConfig
): ResolvedServerConfig {
  const network = toCAIP2(cfg.network);
  const networkName = fromCAIP2(network);
  const facilitator =
    typeof cfg.facilitator === "object"
      ? cfg.facilitator
      : httpFacilitator(cfg.facilitator ?? AIBTC_RELAY_URL[networkName]);
  return {
    network,
    networkName,
    recipient: cfg.recipient,
    asset: assetId(cfg.token ?? "sBTC", networkName),
    facilitator,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 300,
    settle: cfg.settle ?? "after-success"
  };
}

export function buildRequirements(
  cfg: ResolvedServerConfig,
  amount: bigint | number
): PaymentRequirementsV2 {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: BigInt(amount).toString(),
    asset: cfg.asset,
    payTo: cfg.recipient,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds
  };
}

/**
 * The server, not the client, decides what was accepted: we only compare the
 * fields that must match, then verify against our own requirements.
 */
export function matchesRequirements(
  payload: PaymentPayloadV2,
  req: PaymentRequirementsV2
): boolean {
  const a = payload?.accepted;
  return (
    payload?.x402Version === 2 &&
    typeof payload.payload?.transaction === "string" &&
    !!a &&
    a.scheme === req.scheme &&
    a.network === req.network &&
    a.asset === req.asset &&
    a.payTo === req.payTo &&
    a.amount === req.amount
  );
}

/** Attach a payment id so the relay can dedupe retries (payment-identifier extension). */
export function withPaymentId(payload: PaymentPayloadV2): PaymentPayloadV2 {
  if (payload.extensions?.["payment-identifier"]) return payload;
  return {
    ...payload,
    extensions: {
      ...(payload.extensions ?? {}),
      "payment-identifier": { info: { id: `pay_${crypto.randomUUID()}` } }
    }
  };
}
