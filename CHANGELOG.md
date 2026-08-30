# Changelog

## [1.2.3](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.2.2...v1.2.3) (2026-08-29)


### Bug Fixes

* **conformance:** the large-integer vector pinned nothing -- both serials were already collapsed ([#73](https://github.com/4cloudguru/terraform-drift-contract/issues/73)) ([6cbaca1](https://github.com/4cloudguru/terraform-drift-contract/commit/6cbaca1e8a4419149f8748792b264af2a37ea54a)), closes [#18](https://github.com/4cloudguru/terraform-drift-contract/issues/18)

## [1.2.2](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.2.1...v1.2.2) (2026-08-24)


### Bug Fixes

* **ci:** make zizmor fail the build instead of filing a report ([#71](https://github.com/4cloudguru/terraform-drift-contract/issues/71)) ([75d3ab5](https://github.com/4cloudguru/terraform-drift-contract/commit/75d3ab585047993b0a8c60031ad667805c3853ea))

## [1.2.1](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.2.0...v1.2.1) (2026-08-20)


### Bug Fixes

* **ci:** refuse to run signature-replay when Dependabot edited the workflow ([#56](https://github.com/4cloudguru/terraform-drift-contract/issues/56)) ([9fafebd](https://github.com/4cloudguru/terraform-drift-contract/commit/9fafebdc2194a2e787cfd6d408ffc05ac698861e))


### Documentation

* **security:** record the shared-workflow trust relationship, and fix what it invalidated ([#64](https://github.com/4cloudguru/terraform-drift-contract/issues/64)) ([8160fd0](https://github.com/4cloudguru/terraform-drift-contract/commit/8160fd0c14083c2c47a07fcfc3f82af45a8ae7d0))

## [1.2.0](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.1.1...v1.2.0) (2026-08-14)


### Features

* bound the summary, stop the serializer throwing, and say what was not done ([#49](https://github.com/4cloudguru/terraform-drift-contract/issues/49)) ([a7749fb](https://github.com/4cloudguru/terraform-drift-contract/commit/a7749fbc1c210eeab155c6b69a0373edda038c23)), closes [#10](https://github.com/4cloudguru/terraform-drift-contract/issues/10) [#11](https://github.com/4cloudguru/terraform-drift-contract/issues/11) [#14](https://github.com/4cloudguru/terraform-drift-contract/issues/14)


### Bug Fixes

* read plan objects as own properties, and pin the masking control's failure modes ([#43](https://github.com/4cloudguru/terraform-drift-contract/issues/43)) ([216c9ec](https://github.com/4cloudguru/terraform-drift-contract/commit/216c9ec37ff8f1957a12e1149f7c72da43b395ff)), closes [#27](https://github.com/4cloudguru/terraform-drift-contract/issues/27) [#28](https://github.com/4cloudguru/terraform-drift-contract/issues/28) [#30](https://github.com/4cloudguru/terraform-drift-contract/issues/30) [#32](https://github.com/4cloudguru/terraform-drift-contract/issues/32) [#33](https://github.com/4cloudguru/terraform-drift-contract/issues/33) [#34](https://github.com/4cloudguru/terraform-drift-contract/issues/34)
* reconcile the serialized byte form and land a shared conformance corpus ([#48](https://github.com/4cloudguru/terraform-drift-contract/issues/48)) ([94e268c](https://github.com/4cloudguru/terraform-drift-contract/commit/94e268c31f068e1e1effe44d97e535636a646ef7))

## [1.1.1](https://github.com/4cloudguru/terraform-drift-contract/compare/v1.1.0...v1.1.1) (2026-08-13)


### Bug Fixes

* stop trusting the declared type of untrusted plan input, and retract the false parity claims ([#41](https://github.com/4cloudguru/terraform-drift-contract/issues/41)) ([6ef9204](https://github.com/4cloudguru/terraform-drift-contract/commit/6ef92043a95461c1e03ef00b4f806ffe7fec913a)), closes [#24](https://github.com/4cloudguru/terraform-drift-contract/issues/24) [#25](https://github.com/4cloudguru/terraform-drift-contract/issues/25)


### Documentation

* **security:** close the reconciled divergence and drop the drift_summary.py citation ([#38](https://github.com/4cloudguru/terraform-drift-contract/issues/38)) ([3b926ce](https://github.com/4cloudguru/terraform-drift-contract/commit/3b926ce0f0df0a934c496bee29e55541fb688099))

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
