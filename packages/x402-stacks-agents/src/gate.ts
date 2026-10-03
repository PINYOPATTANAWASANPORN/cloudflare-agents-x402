import type {
  PaymentPayloadV2,
  PaymentRequiredV2,
  PaymentRequirementsV2,
  ResourceInfo
} from "x402-stacks";
import {
  matchesRequirements,
  withPaymentId,
  type ResolvedServerConfig
} from "./facilitator";
import { decodePayment } from "./sign";

export type PaymentReceipt = {
  success: true;
  transaction: string;
  network: string;
  payer?: string;
};

export type GateFailure = {
  ok: false;
  reason: string;
  extra?: Record<string, unknown>;
};

/**
 * Transport-agnostic payment flow shared by the MCP and HTTP adapters:
 * decode and match the token, verify it, and settle it with the facilitator.
 */
export function createPaymentGate(
  cfg: ResolvedServerConfig,
  requirements: PaymentRequirementsV2,
  resource: ResourceInfo
) {
  return {
    requirements,

    paymentRequired(
      reason = "PAYMENT_REQUIRED",
      extra: Record<string, unknown> = {}
    ): PaymentRequiredV2 & Record<string, unknown> {
      return {
        x402Version: 2,
        error: reason,
        resource,
        accepts: [requirements],
        ...extra
      };
    },

    async verify(
      token: string
    ): Promise<{ ok: true; payment: PaymentPayloadV2 } | GateFailure> {
      let payment: PaymentPayloadV2;
      try {
        payment = decodePayment(token);
      } catch {
        return { ok: false, reason: "INVALID_PAYMENT" };
      }
      if (!matchesRequirements(payment, requirements)) {
        return { ok: false, reason: "INVALID_PAYMENT" };
      }
      payment = withPaymentId(payment);
      try {
        const vr = await cfg.facilitator.verify(payment, requirements);
        if (!vr.isValid) {
          return {
            ok: false,
            reason: vr.invalidReason ?? "INVALID_PAYMENT",
            extra: { payer: vr.payer }
          };
        }
      } catch {
        return { ok: false, reason: "VERIFY_FAILED" };
      }
      return { ok: true, payment };
    },

    async settle(
      payment: PaymentPayloadV2
    ): Promise<{ ok: true; receipt: PaymentReceipt } | GateFailure> {
      try {
        const s = await cfg.facilitator.settle(payment, requirements);
        if (!s.success) {
          return { ok: false, reason: s.errorReason ?? "SETTLEMENT_FAILED" };
        }
        return {
          ok: true,
          receipt: {
            success: true,
            transaction: s.transaction,
            network: s.network,
            payer: s.payer
          }
        };
      } catch {
        return { ok: false, reason: "SETTLEMENT_FAILED" };
      }
    }
  };
}

export type PaymentGate = ReturnType<typeof createPaymentGate>;
