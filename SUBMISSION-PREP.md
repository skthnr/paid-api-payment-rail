# SUBMISSION-PREP — portico (LOCAL DRAFT, NOT SUBMITTED)

Track: `business` (spec `p0-business.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X → see Y), MEASURED on Celesto Cloud Box B

```
node --test (23 scenarios)     -> tests 23 / pass 23 / fail 0, FINAL_23_RC=0 (323.3 s)
cargo test                     -> 74 passed + 7 passed, 0 failed
cargo clippy (payment-token)   -> EXIT 0 (0 warnings)
cargo clippy (revenue-split)   -> 2 HELD pub fn too_many_arguments in stream.rs (rlib ABI)
cargo near check               -> EXIT 0 both crates
cargo fmt --check              -> EXIT 0 all 3 Cargo manifests
pnpm test (Vitest 5 projects)  -> 61/61 (sdk 42 / mcp 12 / paywall 7) in 1.17 s
pnpm typecheck (TS 7.0.2)      -> EXIT 0
pnpm lint (ESLint 10.15.0)     -> EXIT 0
pnpm format:check              -> EXIT 0
pnpm dedupe --check            -> EXIT 0 (DUP_FINAL=14, down from 48)
git diff --check               -> EXIT 0
```

Chain gas COUNTEREXAMPLED: real near-sandbox `ft_transfer_call`
`gas_burnt_total=11388564732645` = 11.3886 TGas, 10 receipts, SuccessValue.

## Recordable demo outline (human records, human posts)

1. Buyer signs a NEP-366 SignedDelegateAction for a paid API call.
2. Facilitator verifies, settle the split, show both legs credited once.
3. Show a replayed signature rejected. One moment, visible result.
   Q-012 video required when judges cannot open the demo. Tags @NEARProtocol,
   #NEARHackathon. Main writes no post.

## Payload fields — ALL EMPTY, human supplies every value

| Field       | Rule                                                | Value |
| ----------- | --------------------------------------------------- | ----- |
| requestId   | UUID, generated ONCE, reused on 400/503             | EMPTY |
| projectName | 2-80 chars                                          | EMPTY |
| leadName    | 2-80 chars                                          | EMPTY |
| email       | valid, <=160, max 2 submissions per address (Q-015) | EMPTY |
| size        | `1` / `2 - 4` / `4 - 6` / `6 - 8` / `8+`            | EMPTY |
| tracks      | >=1 track id, each once; `business` fits            | EMPTY |
| nearAddress | 2-64 lowercase mainnet account the team creates     | EMPTY |
| projectUrl  | http(s), <=300, public repo, unique                 | EMPTY |
| demoUrl     | http(s), <=300, published X post                    | EMPTY |
| idea        | 20-2000 chars                                       | EMPTY |
| consent     | `true` only after verbatim notice + human yes       | EMPTY |

Never add `website`. Print full JSON, wait for explicit yes. 201 saved;
400 fix `fields` + same requestId; 403 stop; 409 stop; 413 shorten; 503 retry
same requestId.

## Rules checklist

- Q-003: 6 pre-existing tags, none of the required pair; no README diff link.
  **Not satisfied**; local tags deliberately not created.
- Q-012 video required when judges cannot open the demo.
- Q-014 `LICENSE` + `NOTICE` present. Q-017 README "Quickstart — zero-funds
  sandbox" at line 93 and "Testnet quickstart" at line 118.
- Q-015 second project on same email must be named in README. Unresolved.
- Q-002/Q-005 origin disclosure: README "Origin and license disclosure" line 18.
- W5 COUNTEREXAMPLED: TS 7.0.2 + `@typescript/typescript6` 6.0.2 (`TS5102` +
  `TS2345` x4 fixed), ESLint 10.15.0 flat config, Express 5.3.0, Vitest 5.1.0,
  `DUP_FINAL=14` (48 -> 14), final-tree 23/23 `FINAL_23_RC=0` on Celesto Box B.

## Blockers (do not block submission)

Box B Rust `tests/Cargo.toml` full near-workspaces re-run skipped due to shared
Box B 100% disk constraint (23/23 scenarios verified via native
`scripts/lib/sandbox-integration.mjs`). Firecrawl/Exa/Jina/Celesto REST all live.
BoxLite §6 `Dz3VBlqjGIvr` MEASURED FAILURE (`EXIT_CODE=-1`, cleanup DONE).

## Attestation

Nothing published, pushed, tagged, or submitted. No payload value invented.
