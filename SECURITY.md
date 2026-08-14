# Security

`@4cloudguru/terraform-drift-contract` turns a Terraform/OpenTofu plan JSON into
drift counts and a changed-resource summary that is posted to CI logs, PR
comments and the TSM drift API. Plan JSON contains unredacted secrets, so the
redaction behaviour of this package is a security control, not a formatting
detail. Bugs in it are treated as security issues rather than ordinary defects.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub's private vulnerability reporting](https://github.com/4cloudguru/terraform-drift-contract/security/advisories/new)
instead. This keeps the report confidential until a fix is available.

Please include the affected version or commit range, the impact, and a plan
fragment (with real secrets replaced) that reproduces it. You can expect an
acknowledgement within a few business days. Fixes ship as a new release and are
documented in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest published release receives security fixes. Consumers pinned to a
git tag rather than the published npm package do **not** receive them until that
pin moves — that is a property of the pin, not of a release.

## What this package guarantees

- **Attribute values are masked from either sensitivity mirror.** `summarize()`
  emits `attrs[].before` / `attrs[].after` as the literal `"(sensitive)"` when
  **either** `before_sensitive` or `after_sensitive` marks the key. Masking
  happens before `fmt()`, so a *marked* secret is never passed to the formatter.
  Prior to v1.1.0 each side was masked only against its own mirror, so an
  attribute marked on one side had the other side emitted verbatim — that is the
  routine shape for a config-derived mark, which terraform applies to the planned
  value only and never persists to state.

  This guarantee has **two preconditions**, stated here because stating it
  unconditionally is itself a finding. It is applied *per top-level changed key*
  — `isSens()` reads `before_sensitive[k]` / `after_sensitive[k]` and never a
  nested path, so **a secret nested under an unmarked top-level key is serialised
  whole** — and it is driven *entirely* by that metadata, so a plan carrying
  neither mirror gets no masking at all (next section). Neither precondition is
  a bug to be fixed silently; both are how the mirrors behave too.
- **Module provenance is projected, not forwarded.** `moduleCallsPlan()` emits
  only `source` and `version_constraint` per module call. The plan's
  `configuration` block carries no sensitivity metadata at all, so
  `expressions.*.constant_value`, the recursive `module` subtree and its
  variables' defaults are dropped rather than relayed. `source` has URL userinfo
  replaced with `(redacted)@` and every query parameter except `ref` redacted.
- **Emitted strings are bounded.** Every value that goes through `fmt()` is
  capped at 300 code points, and at most 100 module calls are emitted; an
  overflow sets `module_calls_truncated: true`.

Each of these guards is covered by a table-driven test whose rows were verified
by inverting the guard and confirming the rows fail.

## What this package does not guarantee

- **`summary[].address` is not masked, and not truncated.** Resource addresses
  are emitted verbatim, so a `for_each`/`count` key derived from a secret (for
  example `aws_secretsmanager_secret.this["<the secret value>"]`) still reaches
  the summary. This is true of all implementations of the contract. It is a
  known, deliberately unfixed residual: the address is the summary's primary key
  — it is how a drift record is matched to a resource by the backend, by the
  Action and by the ADO task — so masking or truncating it would break record
  identity. Do not use plan output as a place where secrets may safely appear in
  a resource address. It *is* type-checked: a non-string `address` is emitted as
  `""` rather than put into a field the exported type declares `string`.
- **Values are emitted unmasked when the plan carries no sensitivity metadata.**
  When neither `before_sensitive` nor `after_sensitive` is present for a change,
  values are emitted as-is. This is deliberate and fail-open: plans without
  sensitivity metadata are common, masking them would mask every attribute of
  every such plan, and it would diverge from all three other implementations in
  the common case. The decision is pinned by an explicit test row so it cannot
  change silently.
- **Nothing downstream of this package.** How a consumer stores, logs or renders
  the returned object is the consumer's responsibility. Vulnerabilities arising
  from misuse of this API belong to the consuming repository.
- **No credential handling of any kind.** This package has no runtime
  dependencies, performs no I/O and holds no keys or tokens.

## Cross-implementation obligation

The semantics are **defined here** and mirrored by three implementations:

| Implementation | Location |
| --- | --- |
| TypeScript (canonical) | this repository — `src/summarize.ts`, with `__tests__/` as its vectors |
| Go `driftingest` | `terraform-state-manager-backend`, `internal/services/driftingest` |
| jq | the dispatched CI templates in `internal/api/drift_workflows.go` |

`src/summarize.ts` plus its test vectors **is** the authority: it is what the
other two are diffed against, and the only artifact a disagreement can be
settled with. That diffing is mechanised by
[`conformance/vectors.json`](conformance/) — 53 vectors run by all three
implementations and compared byte-for-byte, with each side pinning the same
SHA-256 of the corpus file and the same digest over its own rendered results. A
difference that is real and deliberate is **stated in the vector**; a difference
with no entry there is a regression. Earlier revisions of this document, of the README and of the
sources named a Python `drift_summary.py` as "the canonical dispatch
summarizer". No such file exists — not in this repository, not in
`terraform-state-manager-backend`, not anywhere in the suite's history — so for
as long as it was cited, all three implementations claimed parity with a file
nobody could diff against. The citation has been removed everywhere; do not
reintroduce it.

**A change to the redaction or counting semantics here obliges a matching change
in the others.** A one-sided fix is how a masking control ends up applied in one
runtime and not another for the same drift record.

### Reconciliation status

Both divergences this document previously tracked as open are **closed**.

- **The sensitivity axis is reconciled.** Since v1.1.0 this package masks an
  attribute when either mirror marks it; the Go `driftingest` (`changedAttrs` /
  `maskOrFmt`) takes the same union as of
  [`terraform-state-manager-backend#374`](https://github.com/sethbacon/terraform-state-manager-backend/pull/374),
  verified byte-identical to this package across the sensitivity vectors. This
  axis does not exist in the jq path at all: the dispatched `SUMMARY` emits only
  `{address, actions}` and no `attrs`, so it has no attribute values to mask.
- **The `module_calls` axis is reconciled.** Both dispatched jq templates now
  project each call to `source` (credentials scrubbed) + `version_constraint`,
  capped and bounded exactly as `moduleCallsPlan()` does, verified byte-identical
  to this package across the provenance vectors.

- **The absent-vs-null axis is reconciled.** `stableStringify()` returned the
  *value* `undefined` for an absent key, so `jsonEqual` compared `undefined`
  against `'null'` and reported a change — emitting a phantom
  `{before: null, after: null}` attribute, and giving an entry an `attrs` array
  where the Go-ingested record for the identical plan carried none. Terraform
  produces that shape routinely (an attribute whose post-apply value is unknown
  is omitted from `after` and reported in `after_unknown`). The Go mirror's
  `canon()` has always mapped both an absent key and an explicit null to
  `"null"`; this package now does the same, so the fix **closed** a divergence
  rather than opening one. It is the one behavioural change in that batch and
  reaches consumers only on the next release.

- **The serialized byte form is reconciled.** Keys sort by code point in every
  emitted key set (`stableStringify`, the `attrs` union, and the `module_calls`
  names), U+2028 and U+2029 are escaped in serialized values, `<`/`>`/`&` are
  emitted raw, and negative zero emits `-0`. The Go mirror moved on the HTML
  escaping (it now serialises through an encoder with `SetEscapeHTML(false)`)
  and this package moved on the other three; each direction was chosen because
  the other side could not be made to follow. Every point has a conformance
  vector. Closes the residual formerly tracked as
  [#17](https://github.com/4cloudguru/terraform-drift-contract/issues/17).
- **The jq summary and `drifted` are reconciled.** The dispatched templates now
  skip exactly `["read"]` as well as exactly `["no-op"]`, ignore a JSON `null`
  entry rather than emitting a `{address: null, actions: null}` row, and compute
  `drifted` from the counts instead of `terraform plan -detailed-exitcode` —
  which returns 2 for an output-only diff and made the two producers disagree
  about whether an environment had drifted. Closes
  [#20](https://github.com/4cloudguru/terraform-drift-contract/issues/20) and
  [#21](https://github.com/4cloudguru/terraform-drift-contract/issues/21).

Cross-implementation differences that remain. Both are **pre-existing**, both are
stated per vector in the corpus, neither is a redaction gap, and neither involves
a value being emitted less masked than it is here:

1. **`actions: null` vs `actions: []`.** For a `resource_changes` entry with no
   `actions` key at all, Go marshals its nil `[]string` as `null` where this
   package emits `[]`. Terraform always writes `actions`, so this reaches only a
   hand-built or malformed plan — but a `null` in a stored summary is a real
   shape difference for a consumer that iterates it.
   Corpus: `shape/no-actions-key`.
2. **A malformed document costs the whole plan in Go.** `driftingest.Plan` types
   `address` as a string, `actions` as `[]string` and `module_calls` as a map of
   structs, so a plan carrying the wrong type in any of them fails
   `json.Unmarshal` and `/drift/ingest` answers 422, discarding an otherwise
   valid summary. This package coerces and summarizes normally. Go's behaviour is
   fail-closed, so it is an availability/shape difference, not a disclosure — and
   it is the only implementation that tells the operator the document was
   malformed at all (see the note on
   [#31](https://github.com/4cloudguru/terraform-drift-contract/issues/31)
   finding 43 below).
   Corpus: `shape/non-string-address`, `shape/resource-changes-not-an-array`,
   `shape/actions-not-an-array`.

### Known residuals that need a spec change, not a one-sided edit

These are open, reproduced, and deliberately **not** fixed here, because each
would change what `summarize()` emits and this package's semantics are the thing
the other implementations are diffed against. Fixing any of them one-sidedly
creates exactly the divergence this document exists to prevent. Each needs a
decision recorded across all implementations first:

- **Numbers are IEEE-754 doubles**
  ([#18](https://github.com/4cloudguru/terraform-drift-contract/issues/18)).
  `JSON.parse` collapses integers past 2^53, so two distinct 20-digit serials
  compare equal and the changed attribute is dropped from `attrs` silently.
  Go unmarshals into `interface{}` and hits the same ceiling, so **TS and Go
  agree**, and that agreement is now pinned by the corpus vector
  `serialize/integers-past-2-53-collapse` rather than assumed. This is the one
  part of #18 that is not fixable here: by the time `summarize()` sees the plan,
  the two serials are already the same double. Changing it means parsing the plan
  with a numeric-literal-preserving reader in **every** consumer, which is a
  parse-boundary decision, not an edit inside this package. The formatting halves
  of #18 (whole floats, negative zero) are fixed and have vectors.
- **Nothing bounds the summary**
  ([#14](https://github.com/4cloudguru/terraform-drift-contract/issues/14)).
  `fmt()`'s 300-code-point cap is per value; there is no cap on entries, on
  attrs per entry, or on total bytes, and no counts-only mode. 5000 resources ×
  50 attrs produced a 153 MiB callback body. Adding caps means adding truthful
  truncation markers to the `Result` shape, which is an API and contract change
  for every consumer and mirror.
- **`stableStringify` recursion is unbounded**
  ([#11](https://github.com/4cloudguru/terraform-drift-contract/issues/11)).
  It throws `RangeError` at ~2500 levels of object nesting, out of
  `summarize()` and into the consumer's CI step, suppressing the drift report —
  while `JSON.parse` accepts far deeper documents. A depth limit must be the
  *same* limit in every implementation, and the overflow behaviour (typed error
  vs sentinel value) is a contract decision.
- **Redaction fails open when a plan carries no sensitivity metadata**
  ([#10](https://github.com/4cloudguru/terraform-drift-contract/issues/10)).
  Covered above: deliberate, matched by the Go mirror, pinned by a test row.

The drift callback's `module_locks` field is **not produced by this package** —
each consumer assembles it from `.terraform/modules/modules.json` — but the same
scrubbing obligation applies to it, because it carries the *same* module source
addresses `moduleCallsPlan()` scrubs. `terraform-drift-report` projects and
scrubs it in `projectModuleLocks()`; the backend's dispatched templates do so in
[`terraform-state-manager-backend#377`](https://github.com/sethbacon/terraform-state-manager-backend/pull/377).

## Supply chain

Releases are published to npm by GitHub Actions using **trusted publishing**: the
registry credential is minted from the workflow's OIDC token, so there is no
long-lived `NPM_TOKEN` in this repository or its environments. Every release
carries an npm provenance statement and a build-provenance + SBOM attestation
bound to the exact published tarball, verifiable with:

```bash
npm audit signatures
gh attestation verify --owner 4cloudguru <tarball>
```

The publishing job is gated on the `release` environment (required reviewer, and
a deployment policy restricting it to `v*` tags), runs no dependency code, and is
separated from the build job that does.
