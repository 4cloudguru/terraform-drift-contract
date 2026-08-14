# Conformance corpus

`vectors.json` is the shared corpus for the TSM drift contract: one input plan
per vector plus the **expected output**, hand-authored as intent and never read
back from an implementation.

Three implementations run it and compare byte-for-byte:

| Implementation | Runner |
| --- | --- |
| TypeScript (canonical) | this repo — `__tests__/conformance.test.ts` |
| Go `driftingest` | `terraform-state-manager-backend` — `internal/services/driftingest/conformance_test.go` |
| jq (dispatched CI templates) | `terraform-state-manager-backend` — `internal/api/drift_conformance_test.go` |

## How it detects a divergence without either side seeing the other

Neither CI job can run the other language, so agreement is anchored on three
literals that appear, identically, in both repositories:

- **`CORPUS_SHA256`** — the digest of `vectors.json` itself. The backend vendors
  a byte-identical copy; editing one copy without the other reddens that
  repository.
- **`RECONCILED_DIGEST`** — a digest over the *rendered results* of every vector
  with no stated per-implementation difference. Both sides render through the
  same documented discipline (fixed field order, `attrs` omitted rather than
  null, `<`/`>`/`&` raw, U+2028/U+2029 escaped), so one differing byte anywhere
  in the reconciled set changes the digest on exactly one side.
- **`PROVENANCE_DIGEST`** — the same idea for `moduleCallsPlan()` against the jq
  templates, which is the axis those two share (the dispatched summary carries
  no `attrs` at all).

## Stated differences

A vector may carry a `go` or `jq` key recording a difference that is known and
deliberate — `{"rejects": why}` when that implementation refuses the document
outright, or `{"expect": …, "why": …}` when it answers differently. Those
vectors are excluded from `RECONCILED_DIGEST` and asserted against their own
stated expectation on the mirror's side.

**A difference with no entry in the corpus is a regression.** That is the whole
mechanism: the corpus is where a divergence has to be argued for in writing
before it can be green.

## Changing the corpus

A semantic change lands in all three implementations in the same batch:

1. Edit `vectors.json` here and extend it to cover the new behaviour.
2. Run `npm test`; take the new `CORPUS_SHA256`, `RECONCILED_DIGEST` and
   `PROVENANCE_DIGEST` from the failures and update `__tests__/conformance.test.ts`.
3. Copy `vectors.json` verbatim to
   `terraform-state-manager-backend/backend/internal/services/driftingest/testdata/conformance/vectors.json`
   and update the same three literals in `conformance_test.go` there. They must
   be the same strings; if the Go or jq run produces a different digest, the
   implementations disagree and that is the finding.
4. Open both PRs together and cross-reference them.

If a change cannot move in lockstep, state the difference in the vector rather
than deleting the vector.
