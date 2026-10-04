# Stacks x402 for Cloudflare Agents SDK — Research

_Date: 2026-10-03. Sources: official docs first (developers.cloudflare.com, x402-foundation/x402, docs.stacks.co, docs.hiro.so), then source code and live endpoints. Anything not from an official doc is marked **[code]**, **[live]** or **[secondary]**._

## TL;DR

| Deliverable | Feasible? | Approach |
|---|---|---|
| 1. Stacks x402 add-on for Agents SDK | Yes | **Thin adapter on top of `x402-stacks`** (reuse its signing, verifier, types and memo helpers): `withX402Stacks()` / `withX402StacksClient()` copying `agents/x402`'s API and `_meta` keys, plus a Workers-native Hono paywall. Facilitator: aibtc x402 sponsor relay. Ship as a package plus a `create-cloudflare` template. A native `@x402/core` scheme is optional, later. |
| 2. Wallet onboarding + tagging | Yes | Per-agent wallet in Durable Object storage. Funded from a **dedicated funder address** (the trusted tag), registered in the aibtc identity registry with `framework=cloudflare-agents` (for discovery), plus a SIP-018 attestation. |
| 3. Dashboard | Yes | Hiro Chainhooks → Worker → Queue → D1 ledger; a cron job re-syncs balances through the Hiro API. Volume = sBTC transfers from tagged wallets that are relay-sponsored and/or carry an `x402:` memo. |

---

## 1. Cloudflare Agents SDK and x402 today

Sources: https://developers.cloudflare.com/agents/tools/payments/x402/ (subpages `charge-for-mcp-tools`, `pay-from-agents-sdk`, `charge-for-http-content`); `cloudflare/agents` `packages/agents/src/mcp/client/x402.ts` at `agents@0.26.0` (2026-10-02).

- **Exports (`agents/x402`)**: `withX402(server, { network, recipient: 0x…, facilitator? })` adds `paidTool(name, desc, priceUSD, schema, annotations, cb)`. `withX402Client(client, { account, network?, maxPaymentValue?, confirmationCallback? })` overrides `callTool(confirmCb|null, params)`.
- **EVM only, hardcoded** **[code]**. It calls `registerExactEvmScheme` from `@x402/evm`, `recipient` is typed `0x${string}`, and it builds its `x402ResourceServer` / `x402Client` internally without exposing them. **No Stacks without a fork or a parallel wrapper.**
- **MCP transport** **[code]**:
  - A 402 is returned as a tool result with `_meta["x402/error"] = { x402Version: 2, accepts, resource }`.
  - The client retries with `_meta["x402/payment"]` (base64 JSON). Headers `PAYMENT-SIGNATURE` and `X-PAYMENT` are also accepted.
  - Pricing is advertised in `_meta["agents-x402/paymentRequired"]` and `_meta["agents-x402/priceUSD"]`.
  - Settlement happens only after the tool succeeds.
- **HTTP**: the repo example uses v2 `@x402/hono` (`paymentMiddleware`) and `@x402/fetch` (`wrapFetchWithPayment`). **The docs still show the v1 `x402-hono` API.** Build on v2.
- **Docs vs code**: the docs' scheme table lists EVM, Solana, Aptos, Stellar, Hedera and Sui, but the SDK wrappers only do EVM.
- **Keys**: the docs recommend `wrangler secret put` and `this.env.*`. They give no per-agent wallet guidance. Cloudflare Wallets (https://developers.cloudflare.com/wallets/) are announced but not live (only handle reservation).
- **Other Cloudflare x402 work**:
  - `cloudflare/templates/x402-proxy-template` (still on v1).
  - Pay Per Crawl, which uses its own headers rather than x402.
  - The `batch-settlement` scheme on network `cloudflare:402` in the x402 spec.

## 2. Plugging Stacks into x402 v2

Source: https://github.com/x402-foundation/x402 (coinbase/x402 is now the dev fork). `@x402/*` is at v2.28.0.

- `@x402/core` registries are public and pluggable:
  - `x402ResourceServer.register(network, SchemeNetworkServer)`
  - `x402Client.register(network, SchemeNetworkClient)`
  - `x402Facilitator.register(networks, SchemeNetworkFacilitator)`

  Network IDs are typed `${string}:${string}`, so `stacks:1` fits. `@x402/hono`, `@x402/fetch` and `@x402/mcp` accept caller-built instances, which means **no fork is needed outside `agents/x402`**.
- **There is no official Stacks scheme yet.** It exists only as **PR #962** (`scheme_exact_stacks.md`, open since 2026-01-14): https://github.com/x402-foundation/x402/pull/962
- **CAIP-2 IDs are official**: `stacks:1` (mainnet) and `stacks:2147483648` (testnet). https://github.com/ChainAgnostic/namespaces/blob/main/stacks/caip2.md
- **v2 HTTP headers**: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` (`specs/transports-v2/http.md`).

### Draft spec vs deployed code (needs a decision)

| | PR #962 draft | `x402-stacks` / aibtc relay **[code]** |
|---|---|---|
| Asset id | CAIP-19 (`slip44:5757`, `sip010:SM3V…sbtc-token.sbtc-token`) | `STX`, bare contract id, or `sBTC`/`USDCx`. The relay also accepts CAIP-19. |
| Payload field | `signedTransaction` | `transaction` |
| Header | mentions `X-PAYMENT` (v1) | v2 `payment-signature` |

**Recommendation:** emit CAIP-19 assets and the v2 headers, matching the spec direction, and confirm with aibtcdev (author of PR #962) which payload field the relay will accept long term.

## 3. Stacks x402 ecosystem (what we reuse)

- **Payment = a fully signed Stacks transaction, hex encoded** **[code]**. It is an STX transfer or a SIP-010 `transfer(amount, from, to, memo)`, not a SIP-018 signature. With sponsorship (`extra.feePayer`), the client builds a `sponsored: true, fee: 0` transaction with Deny-mode post-conditions. References: https://docs.stacks.co/reference/stacks.js/stacks-transactions/builders/sponsortransaction.md and https://docs.stacks.co/learn/transactions/post-conditions.md
- **Facilitator: aibtc x402 sponsor relay** — https://github.com/aibtcdev/x402-sponsor-relay
  - Mainnet `https://x402-relay.aibtc.com` (v1.34.0, healthy) **[live]**. Testnet `https://x402-relay.aibtc.dev`.
  - Endpoints: `GET /supported` returns `exact` on `stacks:1`; also `POST /verify`, `POST /settle`, `/payment/:id`, `/stats`, `/wallets`.
  - Pays the gas itself.
  - Exposes a `RelayRPC` Worker entrypoint (`submitPayment`, `checkPayment`), usable through a service binding if deployed on the same Cloudflare account.
- **Packages**:
  - `x402-stacks@2.1.0` **[secondary, third-party]** (github.com/tony1908/x402Stacks): Express middleware, axios client, `X402PaymentVerifier`. Uses `@stacks/transactions` v6. Its middleware isn't usable on Workers, but its types and verifier are (aibtc's `x402-api` does this).
  - There is no `@x402/stacks` package.
- **Workers precedent** **[code]**: aibtcdev `x402-sponsor-relay`, `x402-api` (Hono middleware, `x402.aibtc.com`) and `landing-page` all run on Workers.
- **Workers compatibility**: `@stacks/transactions@7.6.0` was tested under `wrangler dev`. It is about 50 KiB gzipped and pure JS, with `nodejs_compat` on by default from compat date 2026-08-04 (https://developers.cloudflare.com/workers/runtime-apis/nodejs/).
- **Discovery**: x402.aibtc.com, stx402.com and scan.stacksx402.com, via the aibtc MCP tool `list_x402_endpoints`.

## 4. Wallet onboarding and tagging

| Option | Can it be forged? | Cost | Queryable | Role |
|---|---|---|---|---|
| **Dedicated funder address** (iv) | No | Funding only | Chainhook `stx_transfer`/`ft_transfer` filtered on sender | **Source of truth** |
| **aibtc identity registry** (i) | Yes (self-asserted) | One tx | Contract events + `get-metadata` | Discovery, interoperability with the aibtc directory |
| **SIP-018 attestation** (iii) | No | Free | Off-chain only | Proof we can publish |
| Memo on funding tx (ii) | Yes | Free | Print event | Nice-to-have (`cfagents:v1:<id>`) |
| BNS subdomain (v) | No | Per name | Yes | Skip |

- **Identity registry contract**: `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2` **[live]**.
  - Last agent id: 466.
  - `register-full(token-uri, metadata-entries (list 10 {key, value: buff 512}))` writes the tag atomically.
  - `set-agent-wallet-signed` uses SIP-018.
  - The `MetadataSet` event carries the key but not the value, so the indexer must call `get-metadata`.
  - ⚠ `@aibtc/mcp-server` also references an `SP2PABAF…identity-registry-v2`. **Confirm which one is canonical with aibtcdev.**
- **SIP-018**: https://docs.stacks.co/reference/stacks.js/stacks-transactions/signing/signstructureddata.md
- **Proposed onboarding flow**:
  1. The agent's `onStart()` generates a key and stores it in DO SQLite, encrypted with a Workers secret.
  2. The onboarding Worker funds the wallet from the funder address: sBTC to spend plus a little STX for fees (payments are self-paid; the relay's `/settle` does not sponsor).
  3. The wallet calls `register-full` with `framework=cloudflare-agents`.
  4. The onboarding service signs a SIP-018 attestation `{wallet, framework, createdAt}` and stores it in D1.

## 5. Dashboard

- **Ingest**: Hiro Chainhooks 2.0 (Beta) — https://docs.hiro.so/en/tools/chainhooks
  - Filters: `ft_transfer {asset_identifier, sender?, receiver?}`, `stx_transfer`, `contract_call`, `contract_log`.
  - Delivery is an `http_post` webhook. Payloads have `apply` and `rollback` block arrays, so **rollbacks must be handled**.
  - sBTC asset id: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token` (verify before registering).
- **Pipeline**: Chainhook webhook Worker (verify the payload, enqueue) → Cloudflare Queues (at-least-once delivery) → consumer writes to **D1** idempotently, keyed on `tx_id + event_index`.
  - **Cron Trigger** every 5–15 minutes re-syncs balances through the Hiro API.
  - **Analytics Engine** only for charts: 3-month retention, sampled. Not the ledger.
  - Docs: https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/queues/platform/limits/, https://developers.cloudflare.com/analytics/analytics-engine/limits/
- **Hiro API**:
  - Rate limits: 50 requests/min without a key, 500 requests/min with one (https://docs.hiro.so/resources/guides/rate-limits).
  - The v1 `/extended/v1/address/{p}/balances` endpoint is being replaced by `/extended/v3/principals/{p}/balances/{stx|ft|nft}` (https://docs.hiro.so/en/apis/stacks-blockchain-api/v1-to-v3-migration).
- **Counting sBTC x402 volume** (lower bound). Count an sBTC `ft_transfer` when:
  - **the sender is a tagged wallet**, and
  - **the sponsor is a known relay wallet** (`GET https://x402-relay.aibtc.com/wallets`, 10 mainnet wallets **[live]**), **or** the memo starts with `x402:` (sBTC prints the memo as a separate event **[code]**; the relay doesn't require a memo).

  Cross-check against relay `/payment/:id` and `/stats`. Baseline from relay `/stats` on 2026-10-03 **[live]**: 4 settled payments in the last 24h (all sBTC, 400 sats total) and 19 the day before. Traffic is tiny today, so the dashboard is establishing a baseline, not measuring an existing market.
- **Metrics**:
  - Wallets: created, funded, active in the last 7 and 30 days.
  - Holdings: STX, sBTC and USDCx, with USD values.
  - Volume: x402 sBTC volume and payment count, broken down by endpoint and payee.
  - Top paying agents.
- **Comparable dashboards**:
  - x402scan (Merit-Systems/x402scan) **[secondary]**: indexes per facilitator, Base only.
  - aibtc.com agent directory: per-agent `level`, `trust`, `erc8004AgentId` and `capabilities`, but no framework field.

## 6. Reusing `x402-stacks`

`x402-stacks@2.1.0` already provides the Stacks payment primitives. The add-on should depend on it rather than reimplement them.

| Reuse from `x402-stacks` | Missing (what we build) |
|---|---|
| `X402PaymentClient.signSBTCTransfer` / `signSTXTransfer` / `signUSDCxTransfer` / `signPayment` (sign without broadcasting) | MCP integration: `paidTool` + the `_meta["x402/error"]` / `_meta["x402/payment"]` flow from `agents/x402` |
| `X402PaymentVerifierV2` (verify/settle against the relay) | Client `callTool(confirmCb, …)` with human confirmation + a sats-denominated `maxPaymentValue` |
| v2 types, `STACKS_NETWORKS`, `X402_HEADERS_V2`, `networkToCAIP2`, `assetToV2` | Workers/Hono paywall (its `paymentMiddleware` is Express-only; aibtc `x402-api` already has a Hono version to borrow) |
| `createFacilitatorMemo` / `isFacilitatorMemo` / `parsePaymentMemo`, `BTCtoSats` | Per-agent wallet in DO storage, onboarding + tagging, dashboard |

Caveats: it pins `@stacks/transactions` v6 and pulls in axios (it works on Workers, as aibtc's `x402-api` shows), and it doesn't follow PR #962's CAIP-19 assets or `signedTransaction` field. If those become blockers, write a native `@x402/core` scheme later or contribute upstream; it's the same author ecosystem as aibtcdev.

## 7. Proposed repo layout (template + add-on)

```
packages/x402-stacks-agents/      # the add-on (npm), depends on x402-stacks
  mcp.ts                          # withX402Stacks(), withX402StacksClient() — same _meta keys as agents/x402
  hono.ts                         # HTTP paywall via @x402/hono + Stacks scheme
templates/cf-agent-stacks-x402/   # create-cloudflare template
  src/agent.ts                    # Agent with per-DO Stacks wallet
  src/mcp-server.ts               # paidTool priced in sBTC
  src/onboarding.ts               # fund → register-full → attestation
apps/dashboard/                   # Worker + D1 + Queue + Chainhook ingest + UI
```

## 8. Open questions

1. Which identity registry contract is canonical: `SP1NMR7…` or `SP2PABAF…`?
2. Payload field (`transaction` vs `signedTransaction`) and asset format going forward: align with aibtcdev / PR #962.
3. Chainhooks 2.0 pricing, quotas and how webhooks are authenticated (not documented on the pages I read).
4. Exact Hiro v3 paths and the API key header name.
5. Who funds onboarding and the per-wallet budget (sBTC to spend plus about 0.05 STX for fees; relay sponsorship via `/sponsor` needs an aibtc API key).
6. Whether to upstream a PR to `cloudflare/agents` that lets callers inject their own `x402ResourceServer` / `x402Client`, so Stacks plugs into the official `withX402`.
7. ~~Status of other Stacks facilitators~~ Resolved: `facilitator.stacksx402.com` does not respond and the `x402-stacks` default (`x402-backend-7eby.onrender.com`) returns 503 **[live]**. The aibtc relay is the only confirmed working mainnet facilitator, so the add-on must default to it instead of the `x402-stacks` default.

## 9. Correction and mainnet test (2026-10-04)

**Correction.** Earlier sections say the aibtc relay sponsors gas on `/settle`. The relay's own docs (v1.34.0, `src/routes/discovery.ts`) say otherwise: `/settle` broadcasts self-paid or already sponsor-signed transactions, and refuses an empty sponsor slot with `invalid_transaction_state`. Sponsorship exists only through `/sponsor`, which needs an API key. The add-on now builds self-paid transactions by default, so agent wallets need a little STX.

**Mainnet test.** The template ran locally against `stacks:1` with a fresh agent wallet `SP2AJ20ZJC3J6Y0TSRECMNPKNDQ3NMC6ZCFG1VYZ9`.

| Step | Transaction | Result |
|---|---|---|
| Fund agent with 300 sats from a funding wallet | `405f2c4b…7f9f` | confirmed, block 9120117 |
| Fund agent with 0.05 STX for fees | `d5c14510…cf28` | confirmed |
| Agent pays 100 sats for MCP tool `square` | `1e986213…7715` (nonce 0) | confirmed, block 9120178, tool returned `49` |
| Agent pays 100 sats for HTTP `/premium` | `07f5e597…3558` (nonce 1) | confirmed, block 9120178, `200` |

Each payment was self-paid (fee 0.001291 STX), went from the agent back to the funding wallet, and carried an `x402:<nonce>` memo. The agent ended with 100 sats and 0.047418 STX.

**Findings:**
- The relay's `/settle` returns `success` at broadcast, before confirmation, so content is released while the payment is still in the mempool.
- `/verify` doesn't check balances, as noted above.
- A nonce reserved for a payment the relay refused left a gap. The template now reads the nonce from the chain (`possible_next_nonce`, which includes the mempool).
