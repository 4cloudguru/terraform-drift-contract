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

- **Attribute values are masked from either sensitivity mirror, at every
  path.** `summarize()` emits one `attrs` row per changed path (a top-level
  key, or a member of an object or same-length array value under it — see the
  README) and emits a row's `before` / `after` as the literal `"(sensitive)"`
  when **either** `before_sensitive` or `after_sensitive` marks that path.
  Masking happens before `fmt()`, so a *marked* secret is never passed to the
  formatter. Prior to v1.1.0 each side was masked only against its own mirror,
  so an attribute marked on one side had the other side emitted verbatim — that
  is the routine shape for a config-derived mark, which terraform applies to the
  planned value only and never persists to state.

  A **mark** is a truthy scalar in a mirror (terraform writes `true`; any
  truthy scalar is read as one, which is the fail-closed reading of a mirror
  that is not terraform's). A row is masked when a mark sits at its path, at
  any path above it, or anywhere below it, so every value reaches the output
  inside exactly one row and that row is masked whenever any part of the value
  is marked. A mark on a block, map or list therefore masks all of it — keys
  included, since expanding a marked map would put its keys in row names — and a
  mirror whose shape is not the value's (an array mirror on an object, say)
  masks the whole value when it holds any mark rather than being skipped by
  the member-by-member walk.

  **A marked value is masked wherever else it appears in the change.** Marks
  are aligned by path, and a value can change path between the two sides:
  terraform's refresh re-applies prior marks to the refreshed value by path, so
  after an out-of-band reorder of `["S3CR3T","x"]` to `["x","S3CR3T"]` the mark
  stays on index 0 and the secret sits unmarked at index 1; a key renamed next
  to a config-derived mark has the same shape. Path masking alone emitted those
  occurrences in the clear — v1.4.2 masked the whole attribute there — so every
  value a mirror marks anywhere in the resource change (on either side, by
  either mirror, in a changed attribute or not) also masks every row that holds
  it, and a map key that is a marked value is never expanded into a row name.
  This applies to non-empty strings and numbers. null, booleans and `""` are
  not treated as secrets (masking every `""` because one marked value was empty
  would hide real drift), and a value that merely *contains* a marked one is
  not masked.

  A container with **no** mark in it is not sensitive. Up to v1.4.2 any
  non-empty mirror container masked the whole top-level key; terraform writes
  one for every nested block and every list whether or not anything in it is
  sensitive (an azurerm 4.81.0 `blob_properties` is
  `[{"container_delete_retention_policy":[{}],"cors_rule":[],"delete_retention_policy":[{}],"restore_policy":[]}]`,
  a two-CIDR `address_space` is `[false,false]`), so non-secret drift in them
  rendered `(sensitive) -> (sensitive)`. That was over-masking, not a
  disclosure, and its fix emits only values whose paths carry no mark.

  This guarantee has **one precondition**, stated here because stating it
  unconditionally is itself a finding: it is driven *entirely* by that
  metadata. A secret that neither mirror marks — at its path, or as a value
  anywhere else in the change — is emitted, at any depth, and a plan carrying
  neither mirror gets no masking at all (next section). That
  is not a bug to be fixed silently; it is how the mirrors behave too. (Up to
  v1.4.2 there was a second one — masking was per top-level key, so a secret
  under a key whose mirror was `{}` was serialised whole inside that key's
  value. It still is emitted, now as its own row.)

  `drift_summary` (`resource_drift`, optional, additive) is masked by this same
  guarantee, with the same two preconditions — it is produced by the identical
  per-item logic as `summary`, not a second implementation.
- **Module provenance is projected, not forwarded.** `moduleCallsPlan()` emits
  only `source` and `version_constraint` per module call. The plan's
  `configuration` block carries no sensitivity metadata at all, so
  `expressions.*.constant_value`, the recursive `module` subtree and its
  variables' defaults are dropped rather than relayed. `source` has URL userinfo
  replaced with `(redacted)@` and every query parameter except `ref` redacted.
- **Emitted strings are bounded.** Every value that goes through `fmt()` is
  capped at 300 code points, and at most 100 module calls are emitted; an
  overflow sets `module_calls_truncated: true`. An `attrs` row name is never
  truncated (it is the row's identity), so expansion stops before a member's
  name would pass 300 code points, and 16 path segments down; a top-level key
  name is emitted as-is, as it always was.
- **The summary itself is bounded, and says when it was.** At most 500 entries
  and 50 `attrs` rows per entry, defaulted and caller-overridable;
  `truncated`, `omitted_entries` and `omitted_attrs` report an overflow. Every
  changed top-level key keeps at least one row while there are rows left: a
  key's expansion leaves one for each changed key after it, so 50 changed keys
  in a map that sorts first cannot push another attribute's change out of the
  summary (the adversarial review's first draft of per-path rows let them). The
  **counts are deliberately not capped**, so `drifted` stays truthful when the
  summary does not — a bound that suppressed a count would turn a payload limit
  into a missed detection. Before this, 5000 resources x 50 attrs produced a
  153.6 MiB callback body from a plan authorable on a fork PR. `drift_summary`
  is bounded by the same two numbers (see "What this package does not
  guarantee" for the scope of the `truncated`/`unmasked` markers themselves).
- **The per-path walk costs no more than v1.4.2.** Each expanded level compares
  its members again, so the comparison is structural (`sameCanon`): it builds no
  strings and stops at the first difference, and a property test holds it to
  the canonical string comparison it replaces. A first draft serialised members
  at every level and kept the strings: a 256 MiB plan nested 18 deep aborted
  Node out of memory — uncatchable, before the drift callback fired — where
  v1.4.2 used 1.07 GB. Measured now on that plan: 946 MB and 220 ms (v1.4.2:
  1.07 GB and 328 ms); a 1000-resource fleet plan takes 19 ms (20 ms). The
  mirror and marked-value walks are iterative, so no depth can make them throw.
- **The serializer cannot be made to throw.** `stableStringify` is iterative. The
  recursive form threw `RangeError` at ~2,600 levels of nesting, out of
  `summarize()` and into the consumer's CI step — before the drift callback
  fired, so one deeply nested attribute value suppressed drift reporting for the
  whole run. No depth limit is imposed: a limit needs the same number in every
  implementation, and the Go mirror's is `encoding/json`'s own 10,000, which
  rejects the document at the unmarshal boundary rather than emitting a sentinel.
- **A non-plan is distinguishable from a clean plan.** `unparseable` is set when
  the document carries no `resource_changes` array. Consumers must not read
  `drifted: false` as "verified clean" without it.

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
  the common case. The decision is pinned by explicit test rows and by the
  conformance vectors `masking/neither-mirror-is-fail-open` and
  `masking/whole-value-mirror-false` so it cannot change silently.

  What has changed is that the condition is now **reported**: `Result.unmasked`
  is set when a non-skipped in-place change carried neither mirror, so the GitHub
  Action and the ADO task can warn or fail the step, and an operator can tell
  "nothing was sensitive" from "we had no sensitivity metadata". The behaviour is
  unchanged; the silence is not.
- **`unmasked`/`truncated`/`omitted_entries`/`omitted_attrs` report only the
  `resource_changes` path, not `resource_drift`.** An entry in `drift_summary`
  is masked and bounded by the identical rules as `summary` (see "What this
  package guarantees"), but a plan whose *only* unmasked or truncated change
  lives in `resource_drift` still reports `unmasked: false` / `truncated:
  false`. `drift_added`/`drift_changed`/`drift_destroyed`/`drift_summary` do not
  have this gap — they are computed from `resource_drift` and nothing else — it
  is specifically these four marker fields that stay scoped to
  `resource_changes`. This is a deliberate, minimal scope for the additive
  change that introduced `resource_drift`; a consumer that wants a drift-aware
  redaction or truncation signal must inspect `drift_summary` itself rather than
  read these four markers as covering it.
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
[`conformance/vectors.json`](conformance/) — run by all three implementations
and compared byte-for-byte, with each side pinning the same
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
  verified byte-identical to this package across the sensitivity vectors. Since
  v1.5.0 the union applies per path and a mark is a truthy scalar; the Go
  `driftingest` (`walkAttr`) takes the same rules in the same batch, pinned by
  the `attrs/*` and `masking/*` vectors. This axis does not exist in the jq
  path at all: the dispatched `SUMMARY` emits only `{address, actions}` and no
  `attrs`, so it has no attribute values to mask.
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

One more, found by the adversarial review of v1.5.0. It is pre-existing, it is
**not** stated in the corpus, and unlike the two above it **can** change which
values are masked — but only for a document terraform cannot write:

3. **Go decodes some hand-built documents differently.** `encoding/json` matches
   struct field names case-insensitively, so a document carrying both
   `before_sensitive` and a later `BEFORE_SENSITIVE` (or `before_ſensitive`, by
   Unicode folding, or a second `change`) has Go read the other one; and it
   replaces invalid UTF-8 and lone surrogates in keys with U+FFFD, so two keys
   this package keeps apart collide in Go. Either can mask a value in one
   implementation and not the other, in either direction. Terraform writes each
   field once, in lower case, and only valid UTF-8, so a real plan never takes
   either path; a hand-built plan can simply omit the mirrors instead. Numbers
   past float64's range are the related case that was fixed: a mirror holding
   one used to fail to decode in Go and mask nothing, and Go now reads it as a
   mark exactly as this package reads JSON.parse's `Infinity`. In attribute
   values such numbers still differ (`Infinity` serialises as `null` here, and
   Go cannot decode the value at all), which changes rows but masks nothing
   less.

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
  parse-boundary decision, not an edit inside this package -- and doing it is NOT
  sufficient on its own. The obvious reader (a `JSON.parse` reviver returning
  `BigInt(ctx.source)` for unsafe integers) makes `summarize()` throw `TypeError:
  Do not know how to serialize a BigInt`, because `stableStringify` has no BigInt
  branch. Teaching it one is itself a contract change rather than a local fix,
  since Go's `canon()` has no BigInt equivalent and the two would then disagree.
  So the parse-boundary decision has to be taken together with a serializer
  decision on both sides. The formatting halves
  of #18 (whole floats, negative zero) are fixed and have vectors.
- **Redaction fails open when a plan carries no sensitivity metadata**
  ([#10](https://github.com/4cloudguru/terraform-drift-contract/issues/10)).
  Covered above: the behaviour is deliberate, matched by the Go mirror and pinned
  by test rows and vectors; the condition is now reported through
  `Result.unmasked` rather than left silent.

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

## Shared CI workflows

Part of this repository's CI is **defined in another repository** — [`4cloudguru/shared-workflows`](https://github.com/4cloudguru/shared-workflows) — and called from `.github/workflows/`. That is a real supply-chain relationship, and it is recorded here so an audit of this repository does not stop at this repository's own tree.

**What runs, and where it is pinned.** Each caller in `.github/workflows/` names the shared workflow on its `uses:` line, pinned to a full 40-hex commit SHA with a trailing comment naming the release that SHA is. The tag is a label; the SHA is what runs. An unlabelled SHA is rejected by the workflow-hardening gate, because a bare 40-hex ref cannot be reviewed or updated deliberately.

**Why the pins have to agree across repositories.** A shared definition drifts differently from a duplicated file: every repository looks like it is using "the shared one" while sitting on different commits, which is *harder* to see than divergent files, not easier. A signature in `security-orchestration` (`shared-workflow-pin-parity`) reports **disagreement** between callers of the same shared workflow — it reports disagreement rather than staleness, because a repository deliberately held back is a decision while N repositories disagreeing without anyone deciding is drift.

**What the shared repository is itself protected by.** Its `main` requires its own zizmor and actionlint checks with `enforce_admins` enabled, restricts which third-party actions may run to an explicit allowlist, issues a read-only default `GITHUB_TOKEN`, and runs the workflow-hardening gate against itself.

**What this repository still controls.** Triggers, concurrency, and the secrets it passes. Secrets are passed **by name** — never `secrets: inherit`, which would forward every secret in this repository to a workflow owned by someone else. Any `vars.*` a shared workflow reads resolve against **this** repository, so credentials and their installation scope do not move.
