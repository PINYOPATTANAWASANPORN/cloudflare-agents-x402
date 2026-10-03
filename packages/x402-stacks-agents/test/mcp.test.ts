import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import { z } from "zod";
import type { Facilitator } from "../src";
import { withX402Stacks, withX402StacksClient } from "../src/mcp";

const recipient = privateKeyToAddress(randomPrivateKey(), "testnet");
const payerKey = randomPrivateKey();

function makeFacilitator(): Facilitator & {
  verify: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
} {
  return {
    verify: vi.fn(async () => ({ isValid: true, payer: "STPAYER" })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: "0xabc",
      network: "stacks:2147483648" as const,
      payer: "STPAYER"
    }))
  };
}

async function setup(opts: {
  price?: number;
  toolFails?: boolean;
  maxSbtc?: bigint;
  confirm?: (a: unknown) => Promise<boolean>;
  settle?: "after-success" | "before-run";
}) {
  const facilitator = makeFacilitator();
  const server = withX402Stacks(new McpServer({ name: "s", version: "1" }), {
    network: "testnet",
    recipient,
    facilitator,
    settle: opts.settle
  });
  server.paidTool(
    "echo",
    "Echo a message",
    opts.price ?? 100,
    { msg: z.string() },
    {},
    async ({ msg }) =>
      opts.toolFails
        ? { isError: true, content: [{ type: "text", text: "boom" }] }
        : { content: [{ type: "text", text: msg }] }
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const raw = new Client({ name: "c", version: "1" });
  await raw.connect(b);
  const client = withX402StacksClient(raw, {
    privateKey: payerKey,
    network: "testnet",
    getNonce: async () => 0n,
    maxAmount: opts.maxSbtc !== undefined ? { sBTC: opts.maxSbtc } : undefined,
    confirmationCallback: opts.confirm as any
  });
  return { client, facilitator };
}

describe("withX402Stacks + withX402StacksClient", () => {
  it("advertises price in listTools", async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    expect(tools[0].description).toMatch(/paid tool.*100 of ST1PQ.*sbtc-token/);
  });

  it("pays, verifies, runs the tool, then settles", async () => {
    const { client, facilitator } = await setup({});
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "text", text: "hi" }]);
    expect(res._meta?.["x402/payment-response"]).toMatchObject({ success: true, transaction: "0xabc" });

    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    const [payload, req] = facilitator.settle.mock.calls[0];
    expect(req).toMatchObject({ amount: "100", payTo: recipient, network: "stacks:2147483648" });
    expect(payload.payload.transaction).toMatch(/^[0-9a-f]+$/);
    expect(payload.extensions["payment-identifier"].info.id).toMatch(/^pay_/);
  });

  it("does not settle when the tool fails", async () => {
    const { client, facilitator } = await setup({ toolFails: true });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("refuses payments over the cap without signing", async () => {
    const { client, facilitator } = await setup({ price: 5000, maxSbtc: 1000n });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toMatch(/exceeds client cap: 5000 > 1000/);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("respects a declined confirmation", async () => {
    const confirm = vi.fn(async () => false);
    const { client, facilitator } = await setup({ confirm });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(confirm).toHaveBeenCalledOnce();
    expect((res.content as any)[0].text).toBe("User declined payment");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("rejects a payment for a different amount", async () => {
    const { client, facilitator } = await setup({});
    const first = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(first.isError).toBeFalsy();
    // Hand-craft a token whose `accepted` disagrees with the server's requirement.
    const payload = facilitator.settle.mock.calls[0][0];
    const tampered = btoa(JSON.stringify({ ...payload, accepted: { ...payload.accepted, amount: "1" } }));
    const res = await (client as any).callTool(async () => true, {
      name: "echo",
      arguments: { msg: "hi" },
      _meta: { "x402/payment": tampered }
    });
    // Server answers 402 INVALID_PAYMENT to the tampered token; the client then pays properly.
    expect(res.isError).toBeFalsy();
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    expect(facilitator.settle.mock.calls[1][0].accepted.amount).toBe("100");
  });

  it("before-run: settles first and does not run the tool if settlement fails", async () => {
    const { client, facilitator } = await setup({ settle: "before-run" });
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "stacks:2147483648"
    });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect(res.content).not.toContainEqual({ type: "text", text: "hi" });
    expect((res._meta as any)["x402/error"].error).toBe("insufficient_funds");
  });

  it("before-run: charges even when the tool then fails", async () => {
    const { client, facilitator } = await setup({ settle: "before-run", toolFails: true });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(res.isError).toBe(true);
    expect(res._meta?.["x402/payment-response"]).toMatchObject({ success: true });
  });
});
