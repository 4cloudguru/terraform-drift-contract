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
  happens before `fmt()`, so a secret is never passed to the formatter. Prior to
  v1.1.0 each side was masked only against its own mirror, so an attribute marked
  on one side had the other side emitted verbatim — that is the routine shape for
  a config-derived mark, which terraform applies to the planned value only and
  never persists to state.
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
  the summary. This is true of all four implementations of the contract. It is a
  known, deliberately unfixed residual: the address is the summary's primary key
  — it is how a drift record is matched to a resource by the backend, by the
  Action and by the ADO task — so masking or truncating it would break record
  identity. Do not use plan output as a place where secrets may safely appear in
  a resource address.
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

The semantics here are reconciled across four implementations:

| Implementation | Location |
| --- | --- |
| TypeScript (canonical package) | this repository |
| Go `driftingest` | `terraform-state-manager-backend`, `internal/services/driftingest` |
| Python `drift_summary.py` | the canonical dispatch summarizer |
| jq | the dispatched CI templates in `internal/api/drift_workflows.go` |

**A change to the redaction or counting semantics here obliges a matching change
in the others.** A one-sided fix is how a masking control ends up applied in one
runtime and not another for the same drift record.

### Known divergence (open)

Since v1.1.0 this package masks an attribute when **either** mirror marks it.
`drift_summary.py` and the Go `driftingest` (`changedAttrs` / `maskOrFmt`) still
mask each side against its own mirror, so they emit the unmarked side verbatim.
Until they take the same union, an asymmetrically marked attribute renders
differently depending on which implementation produced the record — and the
unmarked side is a real disclosure in those two.

The jq in the backend's dispatched pipelines (both the GitHub and Azure DevOps
templates) still forwards the raw `module_calls` subtree, which is the defect
`moduleCallsPlan()` fixed here, on a path that never calls this package.

Both are tracked as follow-ups outside this repository.

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
