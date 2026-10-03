import {
  Cl,
  Pc,
  makeContractCall,
  makeSTXTokenTransfer,
  privateKeyToAddress
} from "@stacks/transactions";
import {
  createFacilitatorMemo,
  createFacilitatorNonce,
  type PaymentPayloadV2,
  type PaymentRequiredV2,
  type PaymentRequirementsV2
} from "x402-stacks";
import { TOKEN_CONTRACTS, fromCAIP2, tokenForAsset } from "./constants";

export type StacksSigner = {
  privateKey: string;
  /**
   * Build sponsored (fee 0) transactions. The aibtc relay rejects anything
   * else, so this defaults to true.
   */
  sponsored?: boolean;
  /** Account nonce. Fetched from the Stacks API when omitted. */
  nonce?: bigint;
};

/**
 * Sign (never broadcast) a payment for one requirement. Mirrors
 * x402-stacks' internal signPaymentV2 using @stacks/transactions v7,
 * including the `x402:<nonce>` memo used for on-chain attribution.
 */
export async function signPayment(
  req: PaymentRequirementsV2,
  signer: StacksSigner
): Promise<string> {
  const network = fromCAIP2(req.network);
  const token = tokenForAsset(req.asset, network);
  if (!token) throw new Error(`Unsupported asset: ${req.asset}`);

  const amount = BigInt(req.amount);
  const sender = privateKeyToAddress(signer.privateKey, network);
  const memo = createFacilitatorMemo(createFacilitatorNonce());
  const sponsored =
    (signer.sponsored ?? true) || typeof req.extra?.feePayer === "string";
  const fee = sponsored ? { sponsored: true, fee: 0n } : {};
  const nonce = signer.nonce !== undefined ? { nonce: signer.nonce } : {};

  if (token === "STX") {
    const tx = await makeSTXTokenTransfer({
      recipient: req.payTo,
      amount,
      memo,
      senderKey: signer.privateKey,
      network,
      ...fee,
      ...nonce
    });
    return tx.serialize();
  }

  const c = TOKEN_CONTRACTS[network][token];
  const tx = await makeContractCall({
    contractAddress: c.address,
    contractName: c.name,
    functionName: "transfer",
    functionArgs: [
      Cl.uint(amount),
      Cl.principal(sender),
      Cl.principal(req.payTo),
      Cl.some(Cl.bufferFromAscii(memo))
    ],
    // Deny mode: the sponsor can't make this tx move more than `amount`.
    postConditionMode: "deny",
    postConditions: [
      Pc.principal(sender)
        .willSendEq(amount)
        .ft(`${c.address}.${c.name}`, c.assetName)
    ],
    senderKey: signer.privateKey,
    network,
    ...fee,
    ...nonce
  });
  return tx.serialize();
}

export async function createPaymentPayload(
  required: Pick<PaymentRequiredV2, "resource" | "extensions">,
  accepted: PaymentRequirementsV2,
  signer: StacksSigner
): Promise<PaymentPayloadV2> {
  return {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { transaction: await signPayment(accepted, signer) },
    ...(required.extensions ? { extensions: required.extensions } : {})
  };
}

export function encodePayment(payload: PaymentPayloadV2): string {
  return btoa(JSON.stringify(payload));
}

export function decodePayment(token: string): PaymentPayloadV2 {
  return JSON.parse(atob(token)) as PaymentPayloadV2;
}
