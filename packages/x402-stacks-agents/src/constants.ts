import { STACKS_NETWORKS, type NetworkV2 } from "x402-stacks";

export type StacksNetworkName = "mainnet" | "testnet";
export type TokenSymbol = "STX" | "sBTC" | "USDCx";

/**
 * aibtc x402 relay. As of 2026-10 it is the only Stacks facilitator confirmed
 * live on mainnet. Its /settle broadcasts self-paid (or already
 * sponsor-signed) transactions; it does not sponsor, so payers need STX for fees.
 */
export const AIBTC_RELAY_URL: Record<StacksNetworkName, string> = {
  mainnet: "https://x402-relay.aibtc.com",
  testnet: "https://x402-relay.aibtc.dev"
};

type TokenContract = { address: string; name: string; assetName: string };

/** SIP-010 contracts for the tokens the relay settles. */
export const TOKEN_CONTRACTS: Record<
  StacksNetworkName,
  Record<Exclude<TokenSymbol, "STX">, TokenContract>
> = {
  mainnet: {
    sBTC: {
      address: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
      name: "sbtc-token",
      assetName: "sbtc-token"
    },
    USDCx: {
      address: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE",
      name: "usdcx",
      assetName: "usdcx-token"
    }
  },
  testnet: {
    sBTC: {
      address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      name: "sbtc-token",
      assetName: "sbtc-token"
    },
    USDCx: {
      address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      name: "usdcx",
      assetName: "usdcx-token"
    }
  }
};

/** Default per-payment client caps, in each token's atomic unit. */
export const DEFAULT_MAX_AMOUNT: Record<TokenSymbol, bigint> = {
  sBTC: 1_000n, // 1,000 sats
  STX: 1_000_000n, // 1 STX
  USDCx: 100_000n // 0.10 USDCx
};

/**
 * Tool `_meta` keys. `agents-x402/paymentRequired` is shared with Cloudflare's
 * `agents/x402` so existing clients still flag the tool as paid.
 */
export const META = {
  paymentRequired: "agents-x402/paymentRequired",
  price: "agents-x402-stacks/price",
  error: "x402/error",
  payment: "x402/payment",
  paymentResponse: "x402/payment-response"
} as const;

export function toCAIP2(network: StacksNetworkName | NetworkV2): NetworkV2 {
  if (network === "mainnet") return STACKS_NETWORKS.MAINNET;
  if (network === "testnet") return STACKS_NETWORKS.TESTNET;
  return network;
}

export function fromCAIP2(network: string): StacksNetworkName {
  if (network === STACKS_NETWORKS.MAINNET) return "mainnet";
  if (network === STACKS_NETWORKS.TESTNET) return "testnet";
  throw new Error(`Unsupported Stacks network: ${network}`);
}

/** Asset string as used by x402-stacks and the relay: "STX" or "ADDR.contract". */
export function assetId(token: TokenSymbol, network: StacksNetworkName): string {
  if (token === "STX") return "STX";
  const c = TOKEN_CONTRACTS[network][token];
  return `${c.address}.${c.name}`;
}

/** Inverse of {@link assetId}; returns undefined for assets we don't sign. */
export function tokenForAsset(
  asset: string,
  network: StacksNetworkName
): TokenSymbol | undefined {
  if (asset === "STX") return "STX";
  for (const token of ["sBTC", "USDCx"] as const) {
    if (asset === assetId(token, network)) return token;
  }
  return undefined;
}
