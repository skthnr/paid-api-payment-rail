# portico

portico is a NEAR implementation of the x402 v2 `exact` payment scheme for paid APIs. A buyer signs a NEP-366 `SignedDelegateAction` containing one NEP-141 `ft_transfer_call` into a revenue-split contract. A relayer submits the delegate, pays gas and the 1-yocto attached deposit, the contract splits the sale between the developer and the platform, and every sale is appended to a public ledger. Subscription revenue streams accrue per block and are claimed permissionlessly.

- Network: `near:testnet` (CAIP-2), x402 version 2, scheme `exact`
- Testnet accounts: `portico.testnet`, `split.portico.testnet`, `token.portico.testnet`, `relayer.portico.testnet`
- Payment FT: self-deployed NEP-141, **18 decimals**, raw-unit amounts
- License: Apache-2.0 (see `LICENSE` and `NOTICE`)

## Primitives

- **NEP-141** — `portico-payment-token` is the payment FT (18 decimals, raw-unit amounts) and `portico-revenue-split` is its receiver. Each sale is one `ft_transfer_call`, so there is no approval step.
- **NEP-145** — storage management on the FT: `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`, `storage_balance_of`.
- **NEP-366** — `SignedDelegateAction` relay: the buyer signs, the relayer submits. The delegate nonce is bounded by `block_height * 1_000_000` and the TTL by `maxTimeoutSeconds`, which is mapped to `blockHeightTtl` with one block treated as one second.
- **x402 v2 `exact`** — `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` base64 headers, CAIP-2 `near:testnet`, and `GET /supported` advertising the scheme/network pairs plus the relayer `signers`. Verification follows the scheme's MUSTs. The revenue-split path deviates in exactly one documented place: the delegated action is `ft_transfer_call` with a `msg` dispatcher, not the official single `ft_transfer` (see below).
- **NEP-297** — `EVENT_JSON` events for sales, splits, ledger entries and the stream lifecycle.

## Origin and license disclosure

This repository is a NEAR port of [Sperax/x402-stablecoin](https://github.com/Sperax/x402-stablecoin). The origin root `LICENSE` is the Apache License 2.0 and governs the repository as a whole. Some origin files carry MIT SPDX headers and the origin package metadata says MIT. That conflict is resolved in favour of the root license, and `NOTICE` records the attribution. The Solidity contracts are not copied: the NEAR contracts are an independent Rust reimplementation of the documented behaviour. `near-sdk-contract-tools` is dual-licensed `GPL-3.0 OR Apache-2.0`. This project elects Apache-2.0.

The revenue-split path uses `ft_transfer_call`, a documented extension of the official NEAR `exact` scheme (which allows a single `ft_transfer`). The extension keeps `args.receiver_id == accepted.payTo` by pointing `payTo` at the split contract. the `msg` dispatcher binds the quoted tool to its registered developer. Every other verification rule is unchanged.

## Architecture

```
buyer agent
   │ 1 GET resource
   ▼
merchant / paywall ── 2 402 + PAYMENT-REQUIRED (x402 v2) ──▶ buyer
   ▲
   │ 6 PAYMENT-RESPONSE (settled)
   │
   │ 3 PAYMENT-SIGNATURE = NEP-366 SignedDelegateAction
   ▼
@portico/sdk ── 4 POST /verify + /settle ──▶ portico facilitator
                                                │ 5 relay the delegate
                                                │   (relayer pays gas + 1 yocto)
                                                ▼
                                     FT.ft_transfer_call
                                                │
                                                ▼
                                  portico-revenue-split
                                    ├─ developer balance / immediate payout
                                    ├─ platform fee
                                    ├─ per-block stream escrow
                                    └─ ledger entry + NEP-297 event
```

The contract is the settlement and accounting boundary. The facilitator never holds funds: it verifies a signed delegate against a `PaymentRequired` requirement, relays it once, and reports success only when the inner FT receipt is `SuccessValue` in a FINAL outcome.

## Repository layout

```
contracts/
  revenue-split/       portico-revenue-split — NEP-141 receiver, tool registry,
                       per-block streams, ledger, NEP-297 events
  payment-token/       portico-payment-token — NEP-141 FT with NEP-145 storage
facilitator/           Express quote/verify/settle relayer and quote API
packages/sdk/          @portico/sdk — x402 v2 types, headers, NEP-366 builders
mcp/                   stdio MCP server exposing five x402 payment tools
examples/paywall/      merchant API: 402 → payment → fulfillment
scripts/
  sandbox-demo.ts      zero-funds local near-sandbox orchestration
  demo.ts              zero-funds sale → split → ledger → stream loop
  deploy-ft.ts         testnet FT deploy and demo-account seeding
  bench.ts             N=20 gas and latency measurement
tests/                 near-workspaces Rust integration tests
```

## Headline numbers

**Headline (testnet, 2026-11-12): 12.567 TGas and 11.03 s p50 / 11.82 s p95 per gasless sale→80/20 payout.** N=20, every inner FT receipt `SuccessValue`, 12 receipts/loop, 0.022456027285 NEAR burnt total. The delegated attached-gas cap remains 100 TGas (the official `exact` cap. the split signs one `ft_transfer_call` with `teraToGas(100)`). `s per gasless sale` is wall-clock time from the quote request to FINAL settlement.

The run used `split.portico.testnet`, `token.portico.testnet`, relayer `portico.testnet`, buyer `nearhack-major.testnet`, RPC `https://test.rpc.fastnear.com`, and the repository facilitator on `http://127.0.0.1:3002`.

Sandbox row (2026-11-12, `near-sandbox` 2.14.0 — **not comparable**): N=20, p50 12.195 TGas and p50 1.385 s, every inner FT receipt `SuccessValue`. Local block production and finality polling dominate that row. it is not the testnet headline.

`pnpm bench` runs N=20 sale → split → payout loops and reports p50 and p95:

- TGas per loop — sum of `gas_burnt` over the FINAL transaction's `receipts_outcome`, divided by 1e12;
- wall-clock latency per loop — quote request to FINAL;
- `tokens_burnt` — divided by 1e24 and reported separately as NEAR.

Each loop asserts that the inner FT transfer receipt is `SuccessValue`, not just the outer transaction. Gas has a fixed sanity band (7–102 TGas). latency has no invented floor — the measured p50, p95, min and max are recorded with the exact command, so the number is reproducible instead of matched to a block-cadence guess. The run fails closed (non-zero exit) when the stack is unavailable or a gas-band violation occurs, so a failed run cannot print a fabricated median. Human output ends with a `BENCH p50_tgas=… p95_tgas=…` line and a `HEADLINE:` line. `--json` emits the same values. The per-loop transcript, both summary lines and the verdict are written to `PORTICO_BENCH_TRANSCRIPT` (`../W4-NUMBERS.txt` by default, outside the repository). Reproduce from the repo root against a funded stack and a running facilitator:

```bash
pnpm bench           # root script: tsx scripts/bench.ts, human summary
pnpm bench --json    # machine-readable output
```

## Quickstart — zero-funds sandbox

The sandbox quickstart needs no funded account: it starts a local `near-sandbox` node, deploys both WASMs, creates the demo accounts, starts the facilitator and paywall, and executes the complete loop:

```bash
pnpm install

# build the two WASMs first (cargo-near)
(cd contracts/revenue-split && cargo near build non-reproducible-wasm)
(cd contracts/payment-token && cargo near build non-reproducible-wasm)

pnpm sandbox:demo             # root script: tsx scripts/sandbox-demo.ts
```

`pnpm sandbox:demo` runs `scripts/sandbox-demo.ts` and needs no funded testnet account, faucet or API key. The script locates the `near-sandbox` binary (auto glob `target/debug/build/near-sandbox-*/out/.near/near-sandbox-*/near-sandbox`. set `NEAR_SANDBOX_BIN` to override), starts it on ephemeral RPC/network ports under a temporary home, and deploys `contracts/revenue-split/target/near/portico_revenue_split.wasm` and `contracts/payment-token/target/near/portico_payment_token.wasm`. It creates owner, buyer, developer, platform, relayer and stream-subscriber accounts, funds everyone except the buyer, registers the `web-search` tool, and starts the facilitator (`:3002`) and paywall (`:3003`). It then runs `scripts/demo.ts`:

1. `POST /quote` returns 402 with `PAYMENT-REQUIRED`.
2. The SDK signs one NEP-366 delegate for an `ft_transfer_call` with a 1-yocto attached deposit. The buyer holds FT units but **zero liquid NEAR**.
3. The facilitator verifies the delegate, relays it, and waits for FINAL.
4. The split contract pays the developer 80% and credits the platform 20%.
5. `get_ledger` returns the sale; a stream is opened, blocks are fast-forwarded, and the claim is submitted.
6. The script asserts the buyer still holds zero NEAR and that the whole loop finished inside `PORTICO_DEMO_MAX_MS` (default 120000 ms). The transcript is written to the path in `PORTICO_DEMO_TRANSCRIPT` (default `<repo>/../W4-DEMO-TRANSCRIPT.txt`, outside the repository).

Optional sandbox overrides: `PORTICO_SANDBOX_RPC_URL` reuses an already-running sandbox instead of spawning one (then set `PORTICO_SANDBOX_HOME`, or `PORTICO_SANDBOX_ROOT_ACCOUNT` plus `PORTICO_SANDBOX_ROOT_KEY`). `PORTICO_SANDBOX_KEEP_HOME=1` keeps the temporary home for inspection. The default ports 3002 and 3003 must be free (`PORTICO_FACILITATOR_PORT` and `PAYWALL_PORT` override them). The `near-sandbox` binary supports Linux x86_64/ARM64 and macOS ARM64 only. on Windows run the sandbox demo in WSL2.

## Testnet quickstart

```bash
cp .env.example .env          # fill in contract ids and relayer/buyer keys
pnpm install
pnpm deploy:ft                # builds + deploys the FT, registers demo accounts
(cd contracts/revenue-split && cargo near build non-reproducible-wasm)

near contract deploy split.portico.testnet \
  use-file contracts/revenue-split/target/near/portico_revenue_split.wasm \
  with-init-call new \
  json-args '{"owner_id":"portico.testnet","ft_account_id":"token.portico.testnet","platform_wallet":"portico.testnet","platform_fee_bps":2000}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

near contract call-function as-transaction split.portico.testnet register_tool \
  json-args '{"name":"web-search","developer":"dev1.portico.testnet","price":"1000000"}' \
  prepaid-gas '100 Tgas' attached-deposit '0.1 NEAR' \
  sign-as portico.testnet network-config testnet sign-with-keychain send
```

Fund `split.portico.testnet` with at least 1 NEAR for the payment-path storage headroom. `register_tool` refunds any deposit above the computed storage growth plus the 8,192-byte payment reserve.

`register_tool`'s `price` is the demo tool price, `1000000` raw units (the documented Step 8 value), not the quote amount. `POST /quote` for `web-search` returns `100000000000000` raw units. `pay_tool` charges the registered price and refunds the difference, so the buyer's net FT spend is `1000000`.

`scripts/demo.ts` compares the quote with `PORTICO_DEMO_EXPECTED_AMOUNT` when it is set. Set it to the quoted `accepts[0].amount` (`100000000000000` for `web-search`), or delete the line to skip the assertion.

```bash
pnpm --filter @portico/facilitator dev   # :3002
pnpm --filter paywall dev                # :3003
pnpm demo                                # zero-NEAR buyer loop, asserts < 120000 ms
pnpm bench                               # N=20 measured gas/latency
```

## Facilitator API

```bash
pnpm --filter @portico/facilitator dev

curl -i -X POST http://localhost:3002/quote \
  -H 'content-type: application/json' \
  -d '{"service":"web-search"}'
curl -s http://localhost:3002/supported
curl -s http://localhost:3002/quote/pricing
curl -s http://localhost:3002/health
```

`POST /quote` answers HTTP 402 with the base64 `PAYMENT-REQUIRED` header and the same `PaymentRequired` object as JSON. `accepts[].extra` declares `paymentFlow: "upfront"`: `/verify` → `/settle` happens before the resource is served, so the requirement is not the default `authorization` flow. `GET /supported` returns the x402 v2 kinds, empty `extensions`, and the relayer `signers`. `POST /verify` is read-only: it checks the signed delegate against the requirement and never broadcasts. `POST /settle` relays once and returns success only when the inner FT receipt is `SuccessValue` at FINAL. an unavailable broadcast or status lookup returns HTTP 202 with `settlement_pending` and the outer transaction hash so the caller reconciles instead of paying twice. `GET /payments` and `GET /payments/:txHash` expose the duplicate-settlement cache and the RPC transaction status.

## Paywall example

```bash
pnpm --filter paywall dev
curl -i http://localhost:3003/premium
```

The unpaid request returns 402 with `PAYMENT-REQUIRED`. A retry carrying a valid `PAYMENT-SIGNATURE` is checked locally, verified and settled through the facilitator, and only then answered with the paid resource and `PAYMENT-RESPONSE`. `GET /health` reports the configured resource, amount, tool and facilitator. Settlement failure never includes the paid body.

Configure `PAYWALL_PRICE` with the tool's registered raw price (`1000000` for the demo `web-search` tool). the paywall quotes that amount directly.

## MCP server

```bash
pnpm --filter @portico/mcp start
# or, after pnpm build:
node mcp/dist/mcp-server.js
```

The server speaks newline-delimited JSON-RPC 2.0 on stdio (MCP protocol `2024-11-05`, server name `portico-x402`) and exposes `x402_quote`, `x402_pay`, `x402_balance`, `x402_verify_payment` and `x402_estimate_cost`. It reads `PORTICO_TOKEN_CONTRACT`, `PORTICO_SPLIT_CONTRACT`, `FACILITATOR_URL`, `PORTICO_RPC_URL`, `PORTICO_NETWORK`, and — for `x402_pay` — `PORTICO_BUYER_ACCOUNT` plus `PORTICO_BUYER_SECRET_KEY`. A tool failure returns MCP content with `isError: true`, so the transport keeps serving subsequent requests.

## Environment

Core variables and their defaults are documented in `.env.example`. required values fail closed at boot. Sandbox and bench overrides are listed in the same table.

| Variable                               | Default                              | Meaning                                  |
| -------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `PORTICO_RPC_URL`                      | `https://test.rpc.fastnear.com`      | JSON-RPC endpoint                        |
| `PORTICO_NETWORK`                      | `near:testnet`                       | CAIP-2 network in `accepts[]`            |
| `PORTICO_SPLIT_CONTRACT`               | `split.portico.testnet`              | revenue-split contract                   |
| `PORTICO_TOKEN_CONTRACT`               | `token.portico.testnet`              | payment FT                               |
| `PORTICO_EXPECTED_DECIMALS`            | `18`                                 | asserted FT decimals, fixed              |
| `PORTICO_RELAYER_ID`                   | `relayer.portico.testnet`            | relayer account                          |
| `PORTICO_RELAYER_SECRET_KEYS`          | —                                    | JSON array of ed25519 keys               |
| `PORTICO_PLATFORM_WALLET`              | `portico.testnet`                    | fee recipient                            |
| `PORTICO_FEE_BPS`                      | `2000`                               | platform fee, `0..=5000`                 |
| `PORTICO_FACILITATOR_PORT`             | `3002`                               | HTTP port                                |
| `FACILITATOR_URL`                      | `http://localhost:3002`              | public URL used in quotes                |
| `PORTICO_MAX_TIMEOUT_SECONDS`          | `60`                                 | delegate TTL / block budget              |
| `PORTICO_FINALITY_LAG_BLOCKS`          | `3`                                  | optimistic-vs-final TTL allowance        |
| `PORTICO_SETTLEMENT_CACHE_TTL_MS`      | `120000`                             | duplicate-settlement cache TTL           |
| `RATE_LIMIT_WINDOW_MS`                 | `60000`                              | rate-limit window                        |
| `RATE_LIMIT_MAX`                       | `100`                                | requests per window                      |
| `PORTICO_ALLOWED_ORIGINS`              | empty (reflect)                      | comma-separated browser origins          |
| `PORTICO_BUYER_ACCOUNT`                | `buyer1.portico.testnet`             | zero-NEAR buyer account                  |
| `PORTICO_BUYER_SECRET_KEY`             | —                                    | buyer full-access key (demo, MCP)        |
| `PORTICO_STREAM_SUBSCRIBER_ACCOUNT`    | `streamer.portico.testnet`           | stream funder                            |
| `PORTICO_STREAM_SUBSCRIBER_SECRET_KEY` | —                                    | stream funder key                        |
| `PORTICO_STREAM_RECIPIENT`             | `PORTICO_DEV_ACCOUNT`                | stream payee                             |
| `PORTICO_DEMO_TOOL`                    | `web-search`                         | tool paid by the demo and bench          |
| `PORTICO_DEMO_EXPECTED_AMOUNT`         | unset                                | optional quote-amount assertion          |
| `PORTICO_DEMO_MAX_MS`                  | `120000`                             | demo loop budget, asserted               |
| `NEAR_SANDBOX_BIN`                     | auto glob under `target/debug/build` | `near-sandbox` binary                    |
| `PORTICO_SANDBOX_RPC_URL`              | empty                                | reuse a running sandbox RPC              |
| `PORTICO_SANDBOX_HOME`                 | temporary                            | sandbox home when reusing an RPC         |
| `PORTICO_SANDBOX_ROOT_ACCOUNT`         | —                                    | sandbox root account when reusing an RPC |
| `PORTICO_SANDBOX_ROOT_KEY`             | —                                    | sandbox root key when reusing an RPC     |
| `PORTICO_SANDBOX_KEEP_HOME`            | unset                                | `1` keeps the temporary sandbox home     |
| `PORTICO_DEMO_TRANSCRIPT`              | `../W4-DEMO-TRANSCRIPT.txt`          | sandbox demo transcript                  |
| `PORTICO_BENCH_BASE_URL`               | `FACILITATOR_URL`                    | bench facilitator override               |
| `PORTICO_BENCH_LOOPS`                  | `20`                                 | bench loop count                         |
| `PORTICO_BENCH_LOOP_TIMEOUT_MS`        | `120000`                             | per-loop FINAL deadline                  |
| `PORTICO_BENCH_TRANSCRIPT`             | `../W4-NUMBERS.txt`                  | bench transcript path                    |

The paywall surface (`PORTICO_TOKEN_CONTRACT`, `PORTICO_SPLIT_CONTRACT`, `PAYWALL_PORT` 3003, `PAYWALL_PRICE` 1000000 raw units, `PAYWALL_TOOL` `web-search`, `PAYWALL_RESOURCE_URL`, `PAYWALL_DESCRIPTION`, `PAYWALL_MAX_TIMEOUT_SECONDS`, `PAYWALL_ALLOWED_ORIGINS`) is documented in `.env.example` and enforced by `examples/paywall/src/index.ts`.

## Protocol notes

- **Exact amounts.** The facilitator requires `methodName ∈ {ft_transfer, ft_transfer_call}`, `args.amount == accepted.amount`, and `args.receiver_id == accepted.payTo` (the split contract). The split `msg` binds the action and tool to the registered developer.
- **Gas budget.** The split path signs a single `ft_transfer_call` with `teraToGas(100)`, the official delegated-gas cap. The official single-transfer path uses 30 Tgas. payout legs use 10 Tgas and the resolver callback 5 Tgas.
- **Callbacks return `U128` and never panic.** `on_payout_done` restores the developer balance when the payout leg fails and returns the payer's unused amount unchanged. `on_stream_payout_done` restores the claim accounting and returns the failed amount. `on_stream_refund_done` restores the deposit and returns the failed amount. The NEP-141 resolver refunds exactly that value.
- **Timeout mapping.** One block is treated as one second; `blockHeightTtl` equals `maxTimeoutSeconds` from `PAYMENT-REQUIRED` `accepts[0]`.
- **Fee bounds.** `0..=5000` basis points. The platform leg is floored at `amount * fee_bps / 10000` and the developer receives the remainder, so the two legs always sum to the sale amount.
- **Streams.** `cliff_blocks` is a duration from `start_block`, stored as `cliff_end_block` (`3600..=31536000` blocks). Paused blocks never accrue. a claim pays no extra reward. `accrued` is the total earned at the current height, capped at the deposit. `claimable = accrued - withdrawn`. This preserves `accrued + escrow_remaining == deposit` after every claim.
- **Ledger.** `get_ledger(after_id, limit)` paginates the public ledger; the page limit is clamped to `1..=100`. Once 100,000 entries are stored the ledger stops appending, while the event still reaches off-chain indexers.
- **Duplicate settlement.** The cache is keyed by payload hash, fails closed, and evicts at the delegate's `max_block_height` or after the TTL.
- **CORS.** `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` are exposed, `PAYMENT-SIGNATURE` and `Content-Type` are allowed, `Vary: Origin` is always set, and `OPTIONS` is answered without payment.

## Limits and scope

- **Testnet only.** The defaults, env surface and docs target `near:testnet`. There are no mainnet deployment scripts, no mainnet RPC defaults and no real funds. Do not point `PORTICO_NETWORK` or the RPC at mainnet.
- **The relayer prepays.** The buyer account needs an initialized account and a full-access key, but no liquid NEAR: the relayer pays gas and the 1-yocto attached deposit. On a failed inner transfer the unused FT amount is refunded to the transaction signer (the relayer), which caps the sponsored exposure per sale at gas plus 1 yocto. Keep that exposure deliberately small.
- **Asynchronous finality.** `/settle` is finality-bound and can return HTTP 202 `settlement_pending` with the outer transaction hash. Poll `/payments/:txHash` and never re-sign the same delegate until the outcome is known. the duplicate cache refuses a second settlement.
- **Storage headroom caps.** Payment-path writes are unfunded because `ft_on_transfer` receives no NEAR. The contract caps developer balances at 10,000 keys, streams at 10,000, and ledger entries at 100,000, and requires `storage_byte_cost * (storage_usage + entry_bytes + 32768)` of liquid balance before adding a key. A sale that would exceed a cap or the headroom returns the whole amount unused, so the FT refunds it instead of aborting.
- **No custody.** The facilitator holds no buyer funds and no user balances. The contract holds stream escrow and withdrawable developer balances only.
- **Submission is human-only.** This repository contains no publishing, push or submission command: the application payload is reviewed and submitted by a human, and posting about it is human-only. There is no mainnet deployment and no custody of real assets.
- **Streams are payment schedules, not investments.** They accrue a prepaid service budget per block. The repository makes no yield, APY or investment claim.

## Tests

```bash
cargo test --manifest-path contracts/revenue-split/Cargo.toml
cargo test --manifest-path contracts/payment-token/Cargo.toml
cargo test --manifest-path tests/Cargo.toml   # near-workspaces, needs built WASMs
pnpm -r test
pnpm typecheck
pnpm lint
```

The near-workspaces suite needs Linux x86-64/ARM64 or macOS ARM64 (WSL2 on Windows). its helpers deploy the `cargo near build` artifacts from `contracts/<crate>/target/near/`. The repository can be edited on Windows. Run the WASM builds and the sandbox suite on Linux/macOS.

## Requirements

- Node.js >= 26.13.1 and pnpm >= 12.18.0 (the `near-api-js` 7.5.3 engine floor)
- Rust 1.100.0 pinned by `rust-toolchain.toml` (MSRV 1.95) with the `wasm32-unknown-unknown` target
- `cargo-near` 0.23.0 and `near-cli-rs` 0.31.1 for deploy commands
- `near-sandbox` for the zero-funds sandbox quickstart
- A NEAR testnet account with the `near` CLI keychain configured for testnet runs

## License

Apache-2.0. See `LICENSE` for the full text and `NOTICE` for origin attribution and the license-conflict resolution.

## Hackathon

Track: `business`. Development ends 2026-11-14T23:59:00Z (UTC).
