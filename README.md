# terraform-drift-contract

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

The **single source of truth** for parsing a Terraform/OpenTofu plan JSON
(`terraform show -json` / `tofu show -json`) into Terraform State Manager (TSM)
drift counts + a changed-resource summary.

One tiny package, consumed (and bundled) by every drift implementation so they
cannot diverge:

- [`terraform-drift-report`](https://github.com/sethbacon/terraform-drift-report) — the GitHub Action
- the Azure DevOps `TerraformDriftReport` task (`azure-pipelines-terraform`, initiative 6)
- kept in lockstep with the backend's Go `internal/services/driftingest` and the
  jq in the dispatched CI templates, via the vendored golden fixtures.

## API

```ts
import { summarize, moduleCallsPlan, type Plan, type Result } from 'terraform-drift-contract'

const plan: Plan = JSON.parse(fs.readFileSync('plan.json', 'utf8'))
const r: Result = summarize(plan)
// r = { added, changed, destroyed, drifted, summary: [{ address, actions }] }
```

### Semantics (must match `drift_summary.py` exactly)

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
  before `fmt()`, so secrets never reach the formatter). The union is a
  [deliberate divergence](#contract-divergences);
- `drifted` = `(added + changed + destroyed) > 0` (a pure replace has
  `changed == 0` but `drifted == true`; do not infer "no drift" from
  `changed == 0`).

### Module provenance (`moduleCallsPlan`)

Optional, orthogonal to the summary, and **not** part of `drift_summary.py`:
the `plan` field of the drift callback, carrying which modules a root module
calls.

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

### Contract divergences

Where this package is deliberately **stricter** than the other implementations
of the contract (`drift_summary.py`, the Go `driftingest`, and the jq in the
backend's dispatched CI templates). Both entries are fail-closed: they only ever
*add* masking, so any output that was already masked is unchanged.

| Case | Here | `drift_summary.py` / Go `driftingest` |
| --- | --- | --- |
| An attribute marked sensitive on **one** side only (config-derived marks apply to the planned value only, so this is routine) | **both** sides `"(sensitive)"` | each side masked against its own mirror, so the unmarked side is emitted verbatim |
| `module_calls` provenance | projected + credential-scrubbed + capped (above) | the jq templates forward the raw subtree; `drift_summary.py` emits no provenance |

Neither divergence changes counting or skip semantics, and neither changes the
symmetric case (both mirrors marking the key, or neither): those stay
byte-identical. When **neither** mirror is present the change is emitted
unmasked — that is the shape of a plan with no sensitivity metadata at all, and
masking it would mask every attribute of every such plan; this is asserted in
the class test so it cannot change silently.

Until `drift_summary.py` and `driftingest` take the same union, an
asymmetrically marked attribute renders differently depending on which
implementation produced the drift record.

## Consuming it (no registry required)

Both consumers `ncc`-bundle this package, so it is a **build-time only**
dependency — installed straight from git, no npm/GitHub-Packages auth:

```jsonc
// package.json of a consumer
"dependencies": {
  "terraform-drift-contract": "github:sethbacon/terraform-drift-contract#v1.0.0"
}
```

`dist/` is committed, so the git install needs no build step.

## Contract

The fixtures in `__tests__/fixtures/*.json` are vendored from the backend's
`driftingest` tests; the asserted numbers match
`internal/services/driftingest/plan_test.go`. **If the backend semantics change,
update the fixtures here in the same change** — every consumer pulls from here.

## Development

```bash
npm install
npm test        # vitest contract tests
npm run build   # tsc → dist/  (commit the result)
```

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
