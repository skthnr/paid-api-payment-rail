# portico

Tracks `realworld`, `business` · Apache-2.0 (`LICENSE`, `NOTICE`, `ATTRIBUTION.md`) · baseline tag `pre-hackathon` at `9f6b73f` (`x402-stablecoin`); submission `hackathon-submission` (`git rev-parse --short hackathon-submission`); diff `git diff pre-hackathon..hackathon-submission` · Q-015 sibling **eidolon** (agent village economy, tracks `games`, `agents`).

Paid APIs on NEAR: a buyer signs one NEP-366 delegate carrying a NEP-141 transfer, a relayer pays gas, and a contract splits revenue between developer and platform. Subscriptions accrue per block for permissionless claims, so any API can charge per call.

```mermaid
sequenceDiagram
    accTitle: portico runtime flow
    accDescr: Payer wallet, SDK, facilitator, RPC and contracts settle one gasless x402 payment and accrue stream.
    autonumber
    box rgba(255,244,214,0.12) Payer side
    participant W as payer wallet
    participant S as SDK
    end
    box rgba(230,247,235,0.12) NEAR
    participant F as facilitator
    participant R as RPC
    participant T as payment-token
    participant V as revenue-split
    end
    rect rgba(226,238,255,0.20)
    Note over W,V: PHASE 1 — Challenge with 402
    S->>+F: POST /quote
    F-->>-S: PAYMENT-REQUIRED
    end
    rect rgba(230,247,235,0.20)
    Note over W,V: PHASE 2 — Sign payment
    S->>+W: sign one NEP-366 delegate
    W-->>-S: SignedDelegateAction with 1 yoctoNEAR
    end
    rect rgba(255,244,214,0.20)
    Note over W,V: PHASE 3 — Verify signature and nonce
    S->>+F: POST /verify with PAYMENT-SIGNATURE
    par one pinned block hash
    F->>R: viewAccount, viewCode, viewAccessKey
    and
    F->>R: ft_balance_of, get_tool_info, storage_balance_of
    end
    alt guard rejects
    F-->>S: error reason
    else guard accepts
    F-->>-S: verified payload hash
    end
    end
    rect rgba(243,232,255,0.20)
    Note over W,V: PHASE 4 — Relay to chain
    S->>+F: POST /settle
    F->>R: send delegate, relayer pays gas
    R->>T: ft_transfer_call into the split
    T->>+V: ft_on_transfer
    V->>V: developer leg and platform leg
    V-->>-T: used amount, resolver refunds the rest
    F->>R: txStatus FINAL
    alt inner SuccessValue
    F-->>S: PAYMENT-RESPONSE settled
    else timeout
    F-->>-S: settlement_pending plus outer hash
    end
    end
    rect rgba(255,232,232,0.20)
    Note over W,V: PHASE 5 — Accrue stream
    V->>V: open stream with cliff and deposit
    loop each block
    V->>V: accrued grows, paused blocks never accrue
    end
    end
    rect rgba(224,247,250,0.20)
    Note over W,V: PHASE 6 — Claim and withdraw
    V->>T: ft_transfer claimable to recipient
    end
    rect rgba(255,248,225,0.20)
    Note over W,V: PHASE 7 — Fan out events
    V-->>R: EVENT_JSON standard portico
    R-->>F: logs inside FINAL outcome
    end
```

```bash
pnpm install
(cd contracts/revenue-split && cargo near build non-reproducible-wasm)
(cd contracts/payment-token && cargo near build non-reproducible-wasm)
pnpm sandbox:demo
pnpm demo
pnpm bench
pnpm -r test
pnpm typecheck
```

| Do this | See this | Proves |
| --- | --- | --- |
| `pnpm install`; `pnpm sandbox:demo` | deploys token/split/relayer, one gasless sale; HTTP 402 `PAYMENT-REQUIRED`; exit 0 | end-to-end payment |
| `pnpm bench`; `pnpm bench --json` | 12.567 TGas and 11.03 s p50 / 11.82 s p95 per sale | cost is real |
| `pnpm -r test`; `cargo test --manifest-path tests/Cargo.toml` | all pass (61 tests) | behavior tested |
| `cp .env.example .env`; `pnpm deploy:ft` | `register_tool` `web-search`; net spend `1000000` raw units | testnet deploy works |
| `pnpm --filter @portico/facilitator dev`; `curl -i -X POST http://localhost:3002/quote` | HTTP 402 `PAYMENT-REQUIRED`; `/verify` → `/settle`; HTTP 202 `settlement_pending` | x402 v2 `exact` over HTTP 402 |
| `pnpm --filter paywall dev`; `pnpm demo` | 402 → payment → fulfillment; asserts < 120000 ms | merchant paywall works |
| `pnpm --filter @portico/mcp start`; `node mcp/dist/mcp-server.js` | JSON-RPC 2.0 stdio, protocol `2024-11-05`, five `x402_*` tools | five x402 payment tools |
| NEP-141 / NEP-145 FT (18 decimals); NEP-366 `SignedDelegateAction` | NEP-297 `EVENT_JSON`; `near:testnet` (CAIP-2); x402 v2 `exact` | NEP-141/145/366/297 |
| `PORTICO_RPC_URL`=`https://test.rpc.fastnear.com`; `PORTICO_FEE_BPS`=`2000` | fee `0..=5000` bps; 100,000-entry ledger cap | config + invariants |
| `git diff pre-hackathon..hackathon-submission`; `git rev-parse --short hackathon-submission` | tag `pre-hackathon` at `9f6b73f`; upstream `x402-stablecoin` | baseline disclosed |
| "The delegated gas cap stays 100 TGas, the `exact` cap" | "The revenue-split path uses `ft_transfer_call`, a documented extension of the NEAR `exact` scheme (which allows `ft_transfer`)" | Limits: relayer prepays gas + 1 yoctoNEAR; no custody, no yield |

[ATTRIBUTION](ATTRIBUTION.md) · [LICENSE](LICENSE) · origin [Sperax/x402-stablecoin](https://github.com/Sperax/x402-stablecoin) (Apache-2.0).
