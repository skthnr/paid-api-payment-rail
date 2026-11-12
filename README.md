# portico

portico is a NEAR implementation of the x402 v2 `exact` payment scheme for paid
APIs. A buyer signs a NEP-366 `SignedDelegateAction` containing one NEP-141
`ft_transfer_call` into a revenue-split contract. A relayer submits the delegate,
pays gas and the 1-yocto attached deposit, the contract splits the sale between
the developer and the platform, and every sale is appended to a public ledger.
Subscription revenue streams accrue per block and are claimed permissionlessly.

- Network: `near:testnet` (CAIP-2), x402 version 2, scheme `exact`
- Testnet accounts: `portico.testnet`, `split.portico.testnet`,
  `token.portico.testnet`, `relayer.portico.testnet`
- Payment FT: self-deployed NEP-141, **18 decimals**, raw-unit amounts
- License: Apache-2.0 (see `LICENSE` and `NOTICE`)

## Origin and license disclosure

This repository is a NEAR port of
[Sperax/x402-stablecoin](https://github.com/Sperax/x402-stablecoin). The origin
root `LICENSE` is the Apache License 2.0 and governs the repository as a whole;
some origin files carry MIT SPDX headers and the origin package metadata says
MIT. That conflict is resolved in favour of the root license, and `NOTICE`
records the attribution. The Solidity contracts are not copied: the NEAR
contracts are an independent Rust reimplementation of the documented behaviour.
`near-sdk-contract-tools` is dual-licensed `GPL-3.0 OR Apache-2.0`; this project
elects Apache-2.0.

The revenue-split path uses `ft_transfer_call`, a documented extension of the
official NEAR `exact` scheme (which allows a single `ft_transfer`). The extension
keeps `args.receiver_id == accepted.payTo` by pointing `payTo` at the split
contract; every other verification rule is unchanged.

## Architecture

```
buyer agent ── GET resource ──────────────▶ merchant / paywall
     ▲                                        │ 402 + PAYMENT-REQUIRED
     └── PAYMENT-SIGNATURE (delegate) ────────┘
                 │
                 ▼
          @portico/sdk
                 │  POST /verify, POST /settle
                 ▼
        portico facilitator ── preflight gates ──▶ NEAR RPC (finality: final)
                 │  NEP-366 relay (relayer pays gas + 1 yocto)
                 ▼
        FT.ft_transfer_call ──▶ split contract
                                  ├─ developer balance / immediate payout
                                  ├─ platform fee
                                  ├─ per-block stream escrow
                                  └─ ledger entry + NEP-297 event
```

The contract is the settlement and accounting boundary. The facilitator never
holds funds: it verifies a signed delegate against a `PaymentRequired`
requirement, relays it once, and reports success only when the inner FT receipt
is `SuccessValue` in a FINAL outcome.

## Repository layout

```
contracts/
  revenue-split/       portico-revenue-split (NEP-141 receiver, registry,
                       streams, ledger, events)
  payment-token/       portico-payment-token (self-deployed 18-decimal FT)
facilitator/           Express relayer and quote API
packages/sdk/          @portico/sdk — x402 v2 types, headers, client
mcp/                   stdio MCP shell for agent payments
examples/paywall/      merchant API: 402 → payment → fulfillment
scripts/               deploy-ft.ts (testnet FT + demo accounts)
tests/                 near-workspaces sandbox tests
```

## Status

| Wave | Gate | Scope | State |
|---|---|---|---|
| W1 | REPO | monorepo, licenses, env surface, pins, contract foundation, quote surface, SDK headers, FT deploy | remote G1 green |
| W2 | PRIMITIVE | `ft_on_transfer` flows, registry/streams/ledger, facilitator verify/settle, SDK client, unit vectors | remote G2 green (63 + 7 contract tests, 43 SDK tests) |
| W3 | FLOWS | MCP + paywall, sandbox integration tests, deploy + zero-funds rehearsal | after W2 |
| W4 | CLOSE | zero-funds demo, measured gas/latency, README-as-spec, clean-room build | after W3 |

Implemented primitives: NEP-141 `ft_transfer`/`ft_transfer_call` (no approval
step), NEP-145 storage, NEP-366 `SignedDelegateAction` relay, and the x402 v2
`exact` scheme with a 100 Tgas delegated budget and a 1-yocto relayer deposit.

The repository is developed locally and built/tested on a Linux remote; no build
or test command in this repository is required to run on the Windows host.
Sandbox tests (`near-workspaces`) need Linux or macOS — WSL2 on Windows.

## Requirements

- Node.js >= 22.22.2 and pnpm >= 10.4.1 (the `near-api-js` 7.5.3 engine floor)
- Rust 1.99.1 pinned by `rust-toolchain.toml` (MSRV 1.95) with the
  `wasm32-unknown-unknown` target
- `cargo-near` 0.23.0 and `near-cli-rs` 0.31.1 for deploy commands
- A NEAR testnet account with the `near` CLI keychain configured

## Quickstart

```bash
cp .env.example .env          # fill in contract ids and relayer keys
pnpm install
pnpm typecheck

# contracts (Linux/macOS remote)
(cd contracts/revenue-split && cargo near build non-reproducible-wasm)

# deploy the payment FT, register demo accounts, seed buyer1
pnpm deploy:ft

# run the facilitator quote surface
pnpm --filter @portico/facilitator dev
curl -i -X POST http://localhost:3002/quote \
  -H 'content-type: application/json' \
  -d '{"service":"web-search"}'
```

The quote response is HTTP 402 with a base64 `PAYMENT-REQUIRED` header and the
same `PaymentRequired` object as JSON. `GET /quote/pricing` returns the price
table and defaults; `GET /supported` returns the x402 v2 kinds and relayer
signer; `GET /health` reports uptime and cache size.

```bash
curl -s http://localhost:3002/supported
curl -s http://localhost:3002/quote/pricing
```

## Environment

All variables are documented in `.env.example`. Required values fail closed at
boot.

| Variable | Default | Meaning |
|---|---|---|
| `PORTICO_RPC_URL` | `https://test.rpc.fastnear.com` | JSON-RPC endpoint |
| `PORTICO_NETWORK` | `near:testnet` | CAIP-2 network in `accepts[]` |
| `PORTICO_SPLIT_CONTRACT` | `split.portico.testnet` | revenue-split contract |
| `PORTICO_TOKEN_CONTRACT` | `token.portico.testnet` | payment FT |
| `PORTICO_EXPECTED_DECIMALS` | `18` | asserted FT decimals, fixed |
| `PORTICO_RELAYER_ID` | `relayer.portico.testnet` | relayer account |
| `PORTICO_RELAYER_SECRET_KEYS` | — | JSON array of ed25519 keys |
| `PORTICO_PLATFORM_WALLET` | `portico.testnet` | fee recipient |
| `PORTICO_FEE_BPS` | `2000` | platform fee, `0..=5000` |
| `PORTICO_FACILITATOR_PORT` | `3002` | HTTP port |
| `FACILITATOR_URL` | `http://localhost:3002` | public URL used in quotes |
| `PORTICO_MAX_TIMEOUT_SECONDS` | `60` | delegate TTL / block budget |
| `PORTICO_SETTLEMENT_CACHE_TTL_MS` | `120000` | duplicate-settlement cache TTL |
| `RATE_LIMIT_MAX` | `100` | requests per window |
| `PORTICO_ALLOWED_ORIGINS` | empty (reflect) | comma-separated browser origins |

## Protocol notes

- **Exact amounts.** The facilitator requires `args.amount == accepted.amount`
  and `args.receiver_id == accepted.payTo`; the FT transfer is the only action.
- **Gas budget.** The split path signs a single `ft_transfer_call` with
  `teraToGas(100)`, the official delegated-gas cap. Payout legs use 10 Tgas and
  the resolver callback 5 Tgas.
- **Callbacks return `U128`.** `on_payout_done` and `on_stream_payout_done`
  return `0` on success and the failed amount after restoring the ledger, so the
  NEP-141 resolver can refund correctly. They never panic.
- **Timeout mapping.** One block is treated as one second; `blockHeightTtl`
  equals `maxTimeoutSeconds` from `PAYMENT-REQUIRED` `accepts[0]`.
- **Fee bounds.** `0..=5000` basis points; the origin's 100-bps floor existed
  only in the marketplace initializer and is not carried over.
- **Streams.** `cliff_blocks` is a duration from `start_block`, stored as
  `cliff_end_block`; paused blocks never accrue; a claim pays no extra reward.
  `accrued` is the total earned at the current height, capped at the deposit;
  `claimable = accrued - withdrawn`. This preserves
  `accrued + escrow_remaining == deposit` after every claim.
- **Ledger.** `get_ledger(after_id, limit)` paginates the public ledger; the
  scaffold caps it at 100,000 entries so payment-path writes inside
  `ft_on_transfer` never abort a sale.
- **Duplicate settlement.** The cache is keyed by payload hash, fails closed,
  and evicts at the delegate's `max_block_height` or after the TTL.
- **CORS.** `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` are exposed,
  `PAYMENT-SIGNATURE` and `Content-Type` are allowed, `Vary: Origin` is always
  set, and `OPTIONS` is answered without payment.

## Scope

Testnet only. The repository contains no mainnet deployment scripts, no real
funds and no secrets. The zero-funds demo keeps the buyer account's liquid
balance at zero: the relayer prepays gas and the 1-yocto attached deposit, and
the inner delegate is signed by a full-access key on the buyer account.

## License

Apache-2.0. See `LICENSE` for the full text and `NOTICE` for origin attribution
and the license-conflict resolution.
