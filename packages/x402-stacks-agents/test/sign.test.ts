import { describe, expect, it } from "vitest";
import {
  AuthType,
  PostConditionMode,
  deserializeTransaction,
  privateKeyToAddress,
  randomPrivateKey
} from "@stacks/transactions";
import { isFacilitatorMemo } from "x402-stacks";
import { assetId, signPayment } from "../src";

const key = randomPrivateKey();
const payTo = privateKeyToAddress(randomPrivateKey(), "testnet");

describe("signPayment", () => {
  it("builds a self-paid sBTC transfer with a deny-mode post-condition and x402 memo", async () => {
    const hex = await signPayment(
      {
        scheme: "exact",
        network: "stacks:2147483648",
        amount: "250",
        asset: assetId("sBTC", "testnet"),
        payTo,
        maxTimeoutSeconds: 300
      },
      { privateKey: key, nonce: 0n, fee: 2000n }
    );
    const tx = deserializeTransaction(hex);
    expect(tx.auth.authType).toBe(AuthType.Standard);
    expect(tx.auth.spendingCondition.fee).toBe(2000n);
    expect(tx.postConditionMode).toBe(PostConditionMode.Deny);
    expect(tx.postConditions.values).toHaveLength(1);

    const payload = tx.payload as any;
    expect(payload.functionName.content).toBe("transfer");
    expect(payload.contractName.content).toBe("sbtc-token");
    const [amount, , to, memo] = payload.functionArgs;
    expect(amount.value).toBe(250n);
    expect(to.value).toBe(payTo);
    const memoText = new TextDecoder().decode(
      Uint8Array.from(Buffer.from(memo.value.value, "hex"))
    );
    expect(isFacilitatorMemo(memoText)).toBe(true);
  });

  it("builds a sponsored STX transfer when asked", async () => {
    const hex = await signPayment(
      {
        scheme: "exact",
        network: "stacks:2147483648",
        amount: "1000",
        asset: "STX",
        payTo,
        maxTimeoutSeconds: 300
      },
      { privateKey: key, nonce: 0n, sponsored: true }
    );
    const tx = deserializeTransaction(hex);
    expect(tx.auth.authType).toBe(AuthType.Sponsored);
    expect((tx.payload as any).amount).toBe(1000n);
  });

  it("rejects unknown assets", async () => {
    await expect(
      signPayment(
        {
          scheme: "exact",
          network: "stacks:2147483648",
          amount: "1",
          asset: "ST000.not-a-token",
          payTo,
          maxTimeoutSeconds: 300
        },
        { privateKey: key, nonce: 0n }
      )
    ).rejects.toThrow(/Unsupported asset/);
  });
});
