# SUBMISSION-PREP — portico (LOCAL DRAFT, NOT SUBMITTED)

Track: `business` (spec `p0-business.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X → see Y), MEASURED pre-Celesto-only

```
node --test (23 scenarios)     -> tests 23 / pass 23 / fail 0, SUITE_EXIT 0
                                  (faithful, oracle-fixed tree)
cargo test                     -> 74 passed + 7 passed, 0 failed
cargo test (near-workspaces)   -> split_pay_tools_batch_credits_each_leg_once ok
pnpm -r test                   -> 61/61 (sdk 42 / mcp 12 / paywall 7)
pnpm typecheck / pnpm lint     -> EXIT 0 / EXIT 0
cargo check --target wasm32    -> EXIT 0, both crates, single near-sdk 5.30.2
pnpm install --frozen-lockfile -> EXIT 0
git diff --check               -> EXIT 0
```

**Honest caveat**: the FINAL-tree full 23/23 re-run is BLOCKED-BY-CELESTO.
The last full run was a transient `pass 1 / fail 22` after a leaked
near-sandbox; the isolated 23rd scenario and the Rust integration case PASS on
the same tree. Do NOT claim 23/23 on the final tree without a re-run.

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
  sandbox" at line 92 and "Testnet quickstart" at line 117.
- Q-015 second project on same email must be named in README. Unresolved.
- Q-002/Q-005 origin disclosure: README "Origin and license disclosure" line 18.
- HELD with exact output: TS5102 / TS2345 x4 / eslint10 flat-config on the
  `--latest` tree; `DUP_FINAL=47` pnpm-irreducible.

## Blockers (do not block submission)

Celesto `Trial credit is too low to start this sandbox` → final-tree 23/23,
cold-wall consolidation, zero-warning cargo re-verify BLOCKED-BY-CELESTO.
Firecrawl credits BLOCKED. BoxLite §6 `Dz3VBlqjGIvr` MEASURED FAILURE
(`BOX_ID=Dz3VBlqjGIvr`, `EXIT_CODE=-1`, `STDOUT=''`, AssertionError, cleanup
`rt.remove(force=True)` DONE). No fabricated success.

## Attestation

Nothing published, pushed, tagged, or submitted. No payload value invented.
