# portico

portico implements the x402 v2 `exact` payment scheme on NEAR for paid APIs. A buyer signs a NEP-366 `SignedDelegateAction` with one NEP-141 `ft_transfer_call` into a revenue-split contract. A relayer submits the delegate and pays gas plus 1 yoctoNEAR. The contract splits the sale between the developer and the platform, and appends it to a public ledger. Subscription revenue streams accrue per block for permissionless claims.

- Network: `near:testnet` (CAIP-2), x402 version 2, scheme `exact`
- Testnet accounts: `portico.testnet`, `split.portico.testnet`, `token.portico.testnet`, `relayer.portico.testnet`
- Payment FT: self-deployed NEP-141, **18 decimals**, raw-unit amounts
- License: Apache-2.0 (see `LICENSE` and `NOTICE`)

## Primitives

- **NEP-141** — `portico-payment-token` is the payment FT (18 decimals, raw-unit amounts) and `portico-revenue-split` is its receiver. Each sale uses one `ft_transfer_call` without approval.
- **NEP-145** — FT storage management: `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`, `storage_balance_of`.
- **NEP-366** — `SignedDelegateAction` relay: the buyer signs and the relayer submits. The nonce is bounded by `block_height * 1_000_000`. The TTL uses `maxTimeoutSeconds`, mapped to `blockHeightTtl` at one second per block.
- **x402 v2 `exact`** — `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` base64 headers over CAIP-2 `near:testnet`. `GET /supported` advertises scheme/network pairs and relayer `signers`. Verification follows all scheme MUSTs. The revenue-split path changes one rule: it delegates `ft_transfer_call` with a `msg` dispatcher instead of `ft_transfer` (see below).
- **NEP-297** — `EVENT_JSON` events for sales, splits, ledger entries, and streams.

## Origin and license disclosure

This repository ports [Sperax/x402-stablecoin](https://github.com/Sperax/x402-stablecoin) to NEAR. The root `LICENSE` is Apache License 2.0 and governs the repository. Some origin files carry MIT SPDX headers and MIT metadata. That conflict resolves to the root license, and `NOTICE` records attribution. The Solidity contracts are not copied; the NEAR contracts are an independent Rust implementation. `near-sdk-contract-tools` is dual-licensed `GPL-3.0 OR Apache-2.0`. This project elects Apache-2.0.

The revenue-split path uses `ft_transfer_call`, a documented extension of the NEAR `exact` scheme (which allows `ft_transfer`). It keeps `args.receiver_id == accepted.payTo` by setting `payTo` to the split contract. The `msg` dispatcher binds the quoted tool to its registered developer. All other rules stay unchanged.

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

The contract owns settlement and accounting. The facilitator holds no funds. It verifies a signed delegate against `PaymentRequired`, relays once, and requires an inner `SuccessValue` receipt in a FINAL outcome.

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

**Headline (testnet, 2026-11-12): 12.567 TGas and 11.03 s p50 / 11.82 s p95 per gasless sale→80/20 payout.**
N=20, all inner FT receipts `SuccessValue`, 12 receipts/loop, 0.022456027285 NEAR burnt total. The delegated gas cap stays 100 TGas (the `exact` cap). The split signs one `ft_transfer_call` with `teraToGas(100)`. `s per gasless sale` measures wall time from quote request to FINAL.

That run used `split.portico.testnet`, `token.portico.testnet`, relayer `portico.testnet`, buyer `nearhack-major.testnet`, RPC `https://test.rpc.fastnear.com`, and facilitator `http://127.0.0.1:3002`.

Sandbox row (2026-11-12, `near-sandbox` 2.14.0 — **not comparable**): N=20, p50 12.195 TGas, p50 1.385 s, all inner FT receipts `SuccessValue`. Local block production and polling dominate that row. It is not the testnet headline.

`pnpm bench` runs N=20 sale → split → payout loops and reports p50 and p95:

- TGas per loop — sum of `gas_burnt` over `receipts_outcome`, divided by 1e12;
- wall-clock latency per loop — quote request to FINAL;
- `tokens_burnt` — divided by 1e24 and reported as NEAR.

Each loop asserts the inner FT receipt is `SuccessValue`. Gas enforces a sanity band (7–102 TGas). Latency has no floor: p50, p95, min, and max are recorded with the command. The run fails closed on an unavailable stack or band violation. Output ends with `BENCH p50_tgas=… p95_tgas=…` and `HEADLINE:`. `--json` emits the same values. Transcripts and verdicts write to `PORTICO_BENCH_TRANSCRIPT` (`../W4-NUMBERS.txt` by default). Run from the repo root against a funded stack and facilitator:

```bash
pnpm bench           # root script: tsx scripts/bench.ts, human summary
pnpm bench --json    # machine-readable output
```

## Quickstart — zero-funds sandbox

This quickstart needs no funded account. It starts `near-sandbox`, deploys both WASMs, creates accounts, starts the facilitator and paywall, and runs the loop:

```bash
pnpm install

# build the two WASMs first (cargo-near)
(cd contracts/revenue-split && cargo near build non-reproducible-wasm)
(cd contracts/payment-token && cargo near build non-reproducible-wasm)

pnpm sandbox:demo             # root script: tsx scripts/sandbox-demo.ts
```

`pnpm sandbox:demo` runs `scripts/sandbox-demo.ts` with no testnet account or API key. It finds `near-sandbox` (glob `target/debug/build/near-sandbox-*/out/.near/near-sandbox-*/near-sandbox`, override with `NEAR_SANDBOX_BIN`) and starts an ephemeral node. It deploys `contracts/revenue-split/target/near/portico_revenue_split.wasm` and `contracts/payment-token/target/near/portico_payment_token.wasm`. It creates demo accounts, funds non-buyer accounts, registers `web-search`, and starts the facilitator (`:3002`) and paywall (`:3003`). It then runs `scripts/demo.ts`:

1. `POST /quote` returns 402 with `PAYMENT-REQUIRED`.
2. The SDK signs one NEP-366 delegate for `ft_transfer_call` with 1 yoctoNEAR. The buyer holds FT units and **zero liquid NEAR**.
3. The facilitator verifies and relays the delegate, then waits for FINAL.
4. The split contract pays the developer 80% and credits the platform 20%.
5. `get_ledger` returns the sale. Next, a stream opens, blocks fast-forward, and the recipient claims.
6. The script asserts zero buyer NEAR and completion inside `PORTICO_DEMO_MAX_MS` (default 120000 ms). Output writes to `PORTICO_DEMO_TRANSCRIPT` (default `<repo>/../W4-DEMO-TRANSCRIPT.txt`).

Overrides: `PORTICO_SANDBOX_RPC_URL` reuses a running node (with `PORTICO_SANDBOX_HOME`, or `PORTICO_SANDBOX_ROOT_ACCOUNT` plus `PORTICO_SANDBOX_ROOT_KEY`). `PORTICO_SANDBOX_KEEP_HOME=1` retains the temporary home. Ports 3002 and 3003 must be free (`PORTICO_FACILITATOR_PORT` and `PAYWALL_PORT` override them). `near-sandbox` supports Linux x86_64/ARM64 and macOS ARM64 only. On Windows, run inside WSL2.

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

Fund `split.portico.testnet` with 1 NEAR for payment-path storage headroom. `register_tool` refunds excess deposit above storage growth plus the 8,192-byte reserve.

`register_tool`'s `price` is `1000000` raw units (Step 8), not the quote amount. `POST /quote` for `web-search` returns `100000000000000`. `pay_tool` charges the registered price and refunds the difference, so net spend is `1000000`.

`scripts/demo.ts` compares the quote to `PORTICO_DEMO_EXPECTED_AMOUNT` if set. Set it to `accepts[0].amount` (`100000000000000` for `web-search`), or remove the line.

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

`POST /quote` returns HTTP 402 with `PAYMENT-REQUIRED` and a `PaymentRequired` JSON body. `accepts[].extra` sets `paymentFlow: "upfront"` (`/verify` → `/settle` runs before `authorization`). `GET /supported` returns x402 v2 kinds, empty `extensions`, and relayer `signers`. `POST /verify` is read-only and never broadcasts. `POST /settle` relays once and requires inner `SuccessValue` at FINAL. An RPC failure returns HTTP 202 `settlement_pending` with the outer hash for reconciliation. `GET /payments` and `GET /payments/:txHash` query the cache and RPC status.

## Paywall example

```bash
pnpm --filter paywall dev
curl -i http://localhost:3003/premium
```

Unpaid requests return 402 with `PAYMENT-REQUIRED`. Retries with `PAYMENT-SIGNATURE` are verified and settled via the facilitator before returning data and `PAYMENT-RESPONSE`. `GET /health` reports resource, amount, tool, and facilitator. Failed settlements omit the paid body.

Set `PAYWALL_PRICE` to the tool raw price (`1000000` for `web-search`). The paywall quotes that exact amount.

## MCP server

```bash
pnpm --filter @portico/mcp start
# or, after pnpm build:
node mcp/dist/mcp-server.js
```

The server speaks newline-delimited JSON-RPC 2.0 on stdio (protocol `2024-11-05`, name `portico-x402`). It exposes `x402_quote`, `x402_pay`, `x402_balance`, `x402_verify_payment`, and `x402_estimate_cost`. It reads `PORTICO_TOKEN_CONTRACT`, `PORTICO_SPLIT_CONTRACT`, `FACILITATOR_URL`, `PORTICO_RPC_URL`, `PORTICO_NETWORK`, and — for `x402_pay` — `PORTICO_BUYER_ACCOUNT` plus `PORTICO_BUYER_SECRET_KEY`. Failures return `isError: true` so the transport stays alive.

## Environment

Defaults live in `.env.example`. Required variables fail closed at boot.

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

Paywall variables (`PORTICO_TOKEN_CONTRACT`, `PORTICO_SPLIT_CONTRACT`, `PAYWALL_PORT` 3003, `PAYWALL_PRICE` 1000000 raw units, `PAYWALL_TOOL` `web-search`, `PAYWALL_RESOURCE_URL`, `PAYWALL_DESCRIPTION`, `PAYWALL_MAX_TIMEOUT_SECONDS`, `PAYWALL_ALLOWED_ORIGINS`) live in `.env.example` and `examples/paywall/src/index.ts`.

## Protocol notes

- **Exact amounts.** Facilitator checks `methodName ∈ {ft_transfer, ft_transfer_call}`, `args.amount == accepted.amount`, and `args.receiver_id == accepted.payTo`. The `msg` binds the action and tool to the developer.
- **Gas budget.** The split path signs `ft_transfer_call` with `teraToGas(100)`. The single-transfer path uses 30 Tgas. Payouts use 10 Tgas; resolver callbacks use 5 Tgas.
- **Callbacks return `U128` and never panic.** `on_payout_done` restores developer balances on payout failure and returns the payer's unused amount unchanged. `on_stream_payout_done` restores claim state and returns the failed amount. `on_stream_refund_done` restores the deposit and returns the failed amount. The NEP-141 resolver refunds that value.
- **Timeout mapping.** One block equals one second. `blockHeightTtl` equals `maxTimeoutSeconds` from `PAYMENT-REQUIRED` `accepts[0]`.
- **Fee bounds.** `0..=5000` basis points. The platform leg is `amount * fee_bps / 10000` (floored). The developer receives the remainder so both legs sum to the sale.
- **Streams.** `cliff_blocks` starts at `start_block` and saves `cliff_end_block` (`3600..=31536000` blocks). Paused blocks do not accrue. Claims pay no bonus. `accrued` caps at the deposit; `claimable = accrued - withdrawn`. This keeps `accrued + escrow_remaining == deposit`.
- **Ledger.** `get_ledger(after_id, limit)` clamps limit to `1..=100`. After 100,000 entries, ledger writes stop while events continue for off-chain indexers.
- **Duplicate settlement.** The cache keys on payload hash, fails closed, and evicts at `max_block_height` or TTL expiry.
- **CORS.** Expose `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. Allow `PAYMENT-SIGNATURE` and `Content-Type`. Always set `Vary: Origin` and answer `OPTIONS` unpaid.

## Limits and scope

- **Testnet only.** Defaults target `near:testnet`. Do not point `PORTICO_NETWORK` or RPC at mainnet.
- **The relayer prepays.** The buyer needs a full-access key and zero liquid NEAR; the relayer pays gas and 1 yoctoNEAR. On failure, unused FT returns to the relayer, capping exposure at gas plus 1 yocto.
- **Asynchronous finality.** `/settle` can return HTTP 202 `settlement_pending` with the outer hash. Poll `/payments/:txHash` and do not re-sign. The cache blocks duplicate settlement.
- **Storage headroom caps.** Payment writes are unfunded since `ft_on_transfer` carries no NEAR. Caps are 10,000 balance keys, 10,000 streams, and 100,000 ledger entries. Adding a key requires `storage_byte_cost * (storage_usage + entry_bytes + 32768)` liquid balance. Exceeding a cap or headroom refunds the payment unused.
- **No custody.** The facilitator holds zero funds. The contract holds stream escrow and withdrawable developer balances only.
- **Submission is human-only.** No command submits, pushes, or posts. A human reviews and submits the payload. No mainnet deploy or real-asset custody exists.
- **Streams are payment schedules, not investments.** They accrue a prepaid budget per block without yield or APY claims.

## Tests

```bash
cargo test --manifest-path contracts/revenue-split/Cargo.toml
cargo test --manifest-path contracts/payment-token/Cargo.toml
cargo test --manifest-path tests/Cargo.toml   # near-workspaces, needs built WASMs
pnpm -r test
pnpm typecheck
pnpm lint
```

Run the near-workspaces suite on Linux x86-64/ARM64 or macOS ARM64 (WSL2 on Windows). Its helpers deploy `cargo near build` artifacts from `contracts/<crate>/target/near/`.

## Requirements

- Node.js >= 26.13.1 and pnpm >= 12.18.0 (the `near-api-js` 7.5.3 floor)
- Rust 1.100.0 pinned in `rust-toolchain.toml` (MSRV 1.95) with `wasm32-unknown-unknown`
- `cargo-near` 0.23.0 and `near-cli-rs` 0.31.1 for deployments
- `near-sandbox` for the local sandbox quickstart
- A NEAR testnet account in the `near` CLI keychain for testnet runs

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## Hackathon

Track: `business`. Development ends 2026-11-14T23:59:00Z (UTC).
