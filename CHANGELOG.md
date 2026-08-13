# Changelog

## [1.1.0](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.0.0...v1.1.0) (2026-08-13)


### Features

* publish as @4cloudguru/terraform-drift-contract with release-please and npm trusted publishing ([#36](https://github.com/4cloudguru/terraform-drift-contract/issues/36)) ([a891cf3](https://github.com/4cloudguru/terraform-drift-contract/commit/a891cf3902db2ef944fe9c7f3280fd6133a3d7cc))


### Bug Fixes

* **security:** mask on either sensitivity mark, project module provenance ([#35](https://github.com/4cloudguru/terraform-drift-contract/issues/35)) ([b4e4920](https://github.com/4cloudguru/terraform-drift-contract/commit/b4e4920410e161e7457d3891a3849e62b92441cd)), closes [#7](https://github.com/4cloudguru/terraform-drift-contract/issues/7) [#8](https://github.com/4cloudguru/terraform-drift-contract/issues/8)


### Dependencies

* bump nanoid 3.3.16 -&gt; 3.3.18 (GHSA-2v37-7h3g-55p8) so the release-time npm audit gate starts clean ([a891cf3](https://github.com/4cloudguru/terraform-drift-contract/commit/a891cf3902db2ef944fe9c7f3280fd6133a3d7cc))


### Documentation

* add SECURITY.md — the masking guarantees, the deliberate fail-open when a plan carries no sensitivity metadata, the unmasked summary[].address residual, and the obligation to mirror any semantics change into the Go and Python implementations ([a891cf3](https://github.com/4cloudguru/terraform-drift-contract/commit/a891cf3902db2ef944fe9c7f3280fd6133a3d7cc))
* record the PR [#35](https://github.com/4cloudguru/terraform-drift-contract/issues/35) contract divergence — a one-sided sensitivity mark now masks BOTH sides here, while the Go driftingest and drift_summary.py still emit the unmarked side verbatim ([a891cf3](https://github.com/4cloudguru/terraform-drift-contract/commit/a891cf3902db2ef944fe9c7f3280fd6133a3d7cc)), closes [#16](https://github.com/4cloudguru/terraform-drift-contract/issues/16) [#9](https://github.com/4cloudguru/terraform-drift-contract/issues/9) [#10](https://github.com/4cloudguru/terraform-drift-contract/issues/10) [#15](https://github.com/4cloudguru/terraform-drift-contract/issues/15) [#24](https://github.com/4cloudguru/terraform-drift-contract/issues/24) [#25](https://github.com/4cloudguru/terraform-drift-contract/issues/25)


> **Correction to the entry above.** Two claims in it are no longer true, and one
> never was. The Go `driftingest` takes the same union as of
> [terraform-state-manager-backend#374](https://github.com/sethbacon/terraform-state-manager-backend/pull/374),
> which also projected the dispatched jq `module_calls`, so **that divergence is
> closed on both axes**. And `drift_summary.py` does not exist — there is no such
> file in this repository, in `terraform-state-manager-backend`, or anywhere in
> the suite's history. The authority for these semantics is `src/summarize.ts`
> plus its test vectors. See [SECURITY.md](SECURITY.md) for the current
> reconciliation status and the three residual differences, none of which is a
> redaction gap.
