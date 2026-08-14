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
- mirrored by the backend's Go `internal/services/driftingest` and the jq in the
  dispatched CI templates. This package — `src/summarize.ts` plus `__tests__/` —
  is the authority those two are diffed against, **by hand**: there is no shared
  fixture set and no automated conformance run. See
  [cross-implementation status](#cross-implementation-status).

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

> **Consumer status.** Both consumers are on the scoped npm package at
> `^1.1.0` — the GitHub Action (`terraform-drift-report`) and the Azure DevOps
> `TerraformDriftReport` task — so the v1.1.0 redaction fixes reach both. They
> previously pinned the pre-transfer git URL
> `github:sethbacon/terraform-drift-contract#v1.0.0`, which is why an earlier
> revision of this note said fixes did not reach them. `dist/` stays committed
> so the git form keeps working for anything not yet migrated.
>
> **If you must use the git form, pin a commit SHA, not a tag.** A git tag is
> mutable and the tags here are unsigned and unprotected, so
> `github:4cloudguru/terraform-drift-contract#v1.1.0` can be repointed at
> different code with no npm publish, no provenance and no signature to check
> against — in a package two CI systems execute. `#<full-40-char-sha>` is
> immutable. The npm package above is the supported channel and the only one
> that carries provenance.

## API

```ts
import { summarize, moduleCallsPlan, type Plan, type Result } from '@4cloudguru/terraform-drift-contract'

// `Plan` is a compile-time DESCRIPTION of the document, not a runtime check —
// TypeScript interfaces are erased, so every field is `unknown` at run time no
// matter what the annotation says. That is fine here, and deliberately so: the
// plan is attacker-influenceable on a fork PR, and `summarize()` normalises
// every field it reads at the loop head rather than trusting the declared type.
// No separate validator is exported, because a second notion of "valid" would
// be one more thing the four implementations have to agree on.
const plan: Plan = JSON.parse(fs.readFileSync('plan.json', 'utf8'))
const r: Result = summarize(plan)
// r = { added, changed, destroyed, drifted, summary: [{ address, actions }] }
```

**Where this output goes, and why that matters.** Consumers POST `summary` (and
`attrs`) to a TSM callback endpoint over the network, write it to a JSON report
file on the runner, and echo part of it into the CI log. An unmasked `attrs`
value — up to 300 code points of plaintext whenever the sensitivity mirrors are
absent, or whenever the secret sits below an unmarked top-level key — is
therefore transmitted, persisted and displayed, not merely held in memory. Read
the masking semantics below with that in mind.

`fmt` and `isSens` are exported alongside `summarize`/`moduleCallsPlan` and are
part of the public contract: `fmt(v)` is the 300-code-point formatter described
below and `isSens(mirror, key)` is the masking predicate. They are exported so a
porter can check a mirror implementation against them value-by-value, and the
publish workflow asserts all four are present on the CJS entry point. The same
truncation and masking caveats apply to them as to `attrs`.

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
  before `fmt()`, so a marked secret never reaches the formatter). The union
  landed in v1.1.0 and is now matched by the other implementations — see
  [cross-implementation status](#cross-implementation-status).
  **Two preconditions, both real:** masking is applied *per top-level changed
  key* and is driven *entirely* by `before_sensitive`/`after_sensitive`. A
  secret nested under an unmarked top-level key is serialised whole, and a plan
  that omits the sensitivity mirrors gets no masking at all for that resource.
  Do not treat this as a redaction guarantee for plans of unknown or untrusted
  provenance — see [SECURITY.md](SECURITY.md);
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

`__tests__/` is this package's vector set, and this package is the authority.
**If the semantics change here, update the mirrors in the same change** — every
consumer pulls from here.

> **The fixtures are not shared, and nothing verifies parity automatically.** An
> earlier revision of this section said they were "vendored from the backend's
> `driftingest` tests". They are not: the Go package is `plan.go` +
> `plan_test.go` with inline JSON and no `testdata` directory, and the counts
> vectors were re-typed rather than shared — the two sides already use different
> resources for the `attrs` case (`aws_instance.tweak` here,
> `aws_db.x` there). No CI job in any of the three repositories runs the Go or jq
> summarizer over these files, so a divergence introduced on either side is
> green everywhere. Building a real conformance runner is tracked in
> [#22](https://github.com/4cloudguru/terraform-drift-contract/issues/22).

## Development

```bash
npm install
npm test              # vitest contract tests
npm run test:coverage # the same run, gated on the thresholds in vitest.config.mts
npm run lint          # tsc --noEmit
npm run build         # tsc → dist/  (commit the result)
```

CI runs `test:coverage`, not `test`. Every gap this suite has had was an
untested branch — the fail-open masking path, the asymmetric key path, the
prototype-chain read — so the thresholds sit just under the current numbers and
only ever move up.

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
