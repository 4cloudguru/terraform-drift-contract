# @4cloudguru/terraform-drift-contract

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@4cloudguru/terraform-drift-contract.svg)](https://www.npmjs.com/package/@4cloudguru/terraform-drift-contract)

The **single source of truth** for parsing a Terraform/OpenTofu plan JSON
(`terraform show -json` / `tofu show -json`) into Terraform State Manager (TSM)
drift counts + a changed-resource summary.

One tiny package, consumed (and bundled) by every drift implementation so they
cannot diverge:

- [`terraform-drift-report`](https://github.com/sethbacon/terraform-drift-report) — the GitHub Action
- the Azure DevOps `TerraformDriftReport` task (`azure-pipelines-terraform`, initiative 6)
- kept in lockstep with the backend's Go `internal/services/driftingest` and the
  jq in the dispatched CI templates, via the vendored golden fixtures. This
  package — `src/summarize.ts` plus `__tests__/` — is the authority those two are
  diffed against.

## Install

```bash
npm install @4cloudguru/terraform-drift-contract
```

```jsonc
// package.json of a consumer
"dependencies": {
  "@4cloudguru/terraform-drift-contract": "^1.1.0"
}
```

Published to the public npm registry with [provenance](https://docs.npmjs.com/generating-provenance-statements),
so `npm audit signatures` verifies the tarball back to the workflow run that
built it. No registry auth is needed to install it.

> **Consumer status.** Both consumers currently still install this package as a
> git dependency pinned to the `v1.0.0` tag, through the pre-transfer
> `github:sethbacon/terraform-drift-contract#v1.0.0` URL (which redirects here),
> which is why fixes landed after that tag do not reach them. Moving them onto
> the scoped npm
> package is a separate change in each consumer repository. The npm package is
> the supported way to consume this going forward; `dist/` stays committed so
> the git form keeps working for anything not yet migrated.

## API

```ts
import { summarize, moduleCallsPlan, type Plan, type Result } from '@4cloudguru/terraform-drift-contract'

const plan: Plan = JSON.parse(fs.readFileSync('plan.json', 'utf8'))
const r: Result = summarize(plan)
// r = { added, changed, destroyed, drifted, summary: [{ address, actions }] }
```

### Semantics (the authority the other implementations mirror)

- `added` / `changed` / `destroyed` = resources whose actions **contain**
  create / update / delete (a replacement `["delete","create"]` counts as
  **both** added and destroyed; counts are **not** mutually exclusive — use
  `summary.length` for a distinct resource count);
- `summary` = every change whose actions are **not exactly** `["no-op"]` or
  `["read"]`, as `{address, actions, attrs?}`;
- `attrs` (in-place updates/replaces only) = the top-level keys whose value
  differs, each `{name, before, after}` with values run through `fmt()`
  (300 code-point truncation, U+2026 marker) and masked to the literal
  `"(sensitive)"` when **either** `before_sensitive` **or** `after_sensitive`
  marks them (terraform `-json` does **not** pre-mask — masking happens here,
  before `fmt()`, so secrets never reach the formatter). The union landed in
  v1.1.0 and is now matched by the other implementations — see
  [cross-implementation status](#cross-implementation-status);
- `drifted` = `(added + changed + destroyed) > 0` (a pure replace has
  `changed == 0` but `drifted == true`; do not infer "no drift" from
  `changed == 0`).

### Module provenance (`moduleCallsPlan`)

Optional, orthogonal to the summary, and not part of the count/skip semantics
above: the `plan` field of the drift callback, carrying which modules a root
module calls.

The plan's `configuration` block carries **no terraform sensitivity metadata**
at all — `before_sensitive`/`after_sensitive` exist only inside
`resource_changes` — so anything forwarded from it is unredacted by
construction. `module_calls` entries carry `expressions` (the `constant_value`
of every literal argument), the full recursive `module` subtree (its own
resources' expressions and its variables' `default`s, sensitive ones included)
and the raw `source` (which can embed a PAT). The subtree is therefore
**projected, never forwarded verbatim**:

- per call, only `source` and `version_constraint` — exactly the two fields the
  backend's `driftingest.Configuration` reads, so nothing a consumer uses is
  lost. `expressions`, `module` and every other member are dropped;
- `source` has its credentials scrubbed: URL userinfo (`https://token@host/…`,
  `https://user:pass@host/…`) becomes `(redacted)@`, and of the query
  parameters only `ref` survives — every other value (`sshkey=`,
  `X-Amz-Signature=`, `token=`) is redacted;
- every emitted string is capped by `fmt()` at 300 code points, and at most
  **100** module calls are emitted (sorted by name); an overflow sets
  `configuration.root_module.module_calls_truncated: true`.

### Cross-implementation status

The two redaction behaviours this package introduced ahead of the others are now
**matched by both** — the Go `driftingest` and the jq in the backend's dispatched
CI templates:

| Behaviour | Status |
| --- | --- |
| An attribute marked sensitive on **one** side only (config-derived marks apply to the planned value only, so this is routine) → **both** sides `"(sensitive)"` | reconciled with Go in [backend#374](https://github.com/sethbacon/terraform-state-manager-backend/pull/374); the jq path has no `attrs` to mask |
| `module_calls` provenance projected + credential-scrubbed + capped (above) | both jq templates project identically as of [backend#374](https://github.com/sethbacon/terraform-state-manager-backend/pull/374) |

Neither behaviour changes counting or skip semantics, and neither changes the
symmetric case (both mirrors marking the key, or neither): those stay
byte-identical. When **neither** mirror is present the change is emitted
unmasked — that is the shape of a plan with no sensitivity metadata at all, and
masking it would mask every attribute of every such plan; this is asserted in
the class test so it cannot change silently.

Three differences do remain — `actions: null` vs `[]` on a plan with no
`actions` key, Go answering 422 for a malformed `configuration` where this
package tolerates it, and the jq `SUMMARY` not skipping `["read"]` while taking
`drifted` from the plan's exit code. All three are pre-existing and **none is a
redaction gap**. See [SECURITY.md](SECURITY.md) for the detail and for the
cross-implementation obligation.

> **Note.** Earlier revisions of this README named a Python `drift_summary.py` as
> the file these semantics must match. No such file exists anywhere in the suite.
> The authority is this package: `src/summarize.ts` and its test vectors.

## Contract

The fixtures in `__tests__/fixtures/*.json` are vendored from the backend's
`driftingest` tests; the asserted numbers match
`internal/services/driftingest/plan_test.go`. **If the backend semantics change,
update the fixtures here in the same change** — every consumer pulls from here.

## Development

```bash
npm install
npm test        # vitest contract tests
npm run lint    # tsc --noEmit
npm run build   # tsc → dist/  (commit the result)
```

`dist/` is committed and CI fails if it is stale, so a source change that is not
rebuilt in the same commit does not merge.

## Releasing

There is no manual publish step and no long-lived registry token.

1. **Land conventional commits on `main`.** PR titles are validated by the
   `Conventional PR Title` check and PRs are squash-merged, so the PR title
   becomes the commit subject that release-please reads.
2. **release-please opens a release PR** (`.github/workflows/release-please.yml`)
   computing the next version from the commit history — `fix:` → patch, `feat:`
   → minor, `BREAKING CHANGE:` → major. It maintains `CHANGELOG.md`, the
   `package.json` version and `.release-please-manifest.json`. Per the suite
   convention, one merged commit announces **at most one** breaking change.
3. **Merging the release PR** tags `vX.Y.Z` and publishes a GitHub Release.
4. **The release publishes the package** (`.github/workflows/publish.yml`): an
   unprivileged job builds, tests, audits and packs the tarball, then a separate
   job — gated on the `release` environment's required reviewer and a `v*` tag
   policy — publishes it.

Publishing uses **npm trusted publishing**: the registry credential is minted
from the workflow's OIDC token and matched against the trusted publisher
configured on npmjs for this package. There is no `NPM_TOKEN` anywhere, and the
publishing job holds no repository secrets. `publishConfig.provenance` plus
`id-token: write` produce the provenance attestation, and the published tarball
is additionally attested with its CycloneDX SBOM.

The CHANGELOG is load-bearing: this package's semantics are mirrored by a Go and
a jq implementation, and the release notes are how those learn that a divergence
exists.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
