import { privateKeyToAddress } from "@stacks/transactions";
import type {
  NetworkV2,
  PaymentPayloadV2,
  PaymentRequiredV2,
  PaymentRequirementsV2
} from "x402-stacks";
import {
  DEFAULT_MAX_AMOUNT,
  fromCAIP2,
  toCAIP2,
  tokenForAsset,
  type StacksNetworkName,
  type TokenSymbol
} from "./constants";
import { createPaymentPayload } from "./sign";

export type StacksPayerConfig = {
  /** Hex private key of the paying wallet. */
  privateKey: string;
  network: StacksNetworkName | NetworkV2;
  /** Per-payment caps in atomic units. Merged over DEFAULT_MAX_AMOUNT. */
  maxAmount?: Partial<Record<TokenSymbol, bigint>>;
  /** Called before every payment; return false to decline. */
  confirmationCallback?: (
    accepts: PaymentRequirementsV2[]
  ) => Promise<boolean>;
  /** Build sponsored transactions (required by the aibtc relay). Default true. */
  sponsored?: boolean;
  /**
   * Supply the account nonce (e.g. from agent state, so concurrent payments
   * don't collide). Fetched from the Stacks API when omitted.
   */
  getNonce?: (address: string) => Promise<bigint>;
};

export class PaymentDeclinedError extends Error {}
export class PaymentCapError extends Error {}
export class NoCompatibleRequirementError extends Error {}

export function payerAddress(cfg: StacksPayerConfig): string {
  return privateKeyToAddress(cfg.privateKey, fromCAIP2(toCAIP2(cfg.network)));
}

/**
 * Pick the first requirement on our network in a token we can sign, enforce
 * the cap, ask for confirmation, then sign. Throws typed errors on refusal.
 */
export async function payFor(
  required: PaymentRequiredV2,
  cfg: StacksPayerConfig,
  confirm = cfg.confirmationCallback
): Promise<PaymentPayloadV2> {
  const network = toCAIP2(cfg.network);
  const networkName = fromCAIP2(network);
  const caps = { ...DEFAULT_MAX_AMOUNT, ...cfg.maxAmount };

  // Work on a copy so nothing the server or callback holds can alter what we sign.
  const accepts = structuredClone(required.accepts ?? []);
  const candidates = accepts.filter(
    (r) =>
      r.scheme === "exact" &&
      r.network === network &&
      tokenForAsset(r.asset, networkName) !== undefined
  );
  if (candidates.length === 0) {
    throw new NoCompatibleRequirementError(
      `No payable Stacks requirement for ${network}. Offered: ${accepts
        .map((r) => `${r.scheme}/${r.network}/${r.asset}`)
        .join(", ")}`
    );
  }

  const selected = candidates[0];
  const token = tokenForAsset(selected.asset, networkName)!;
  let amount: bigint;
  try {
    amount = BigInt(selected.amount);
  } catch {
    throw new NoCompatibleRequirementError(
      `Malformed amount: ${selected.amount}`
    );
  }
  if (amount < 0n) {
    throw new NoCompatibleRequirementError(`Negative amount: ${amount}`);
  }
  if (amount > caps[token]) {
    throw new PaymentCapError(
      `Payment exceeds client cap: ${amount} > ${caps[token]} (${token})`
    );
  }

  if (confirm && !(await confirm(structuredClone(accepts)))) {
    throw new PaymentDeclinedError("User declined payment");
  }

  return createPaymentPayload(required, selected, {
    privateKey: cfg.privateKey,
    sponsored: cfg.sponsored,
    nonce: cfg.getNonce ? await cfg.getNonce(payerAddress(cfg)) : undefined
  });
}
