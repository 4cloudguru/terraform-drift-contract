// Public surface of the TSM drift contract. The single source of truth for the
// count/summary/attrs semantics shared by every drift consumer:
//   - the GitHub Action  (terraform-drift-report)
//   - the Azure DevOps task (TerraformDriftReport, initiative 6)
//   - mirrored by the backend's internal/services/driftingest (Go) and by the jq
//     in its dispatched CI templates. This package (src/summarize.ts +
//     __tests__/) is the authority they are diffed against; see SECURITY.md.
//
// That diffing is done BY HAND. An earlier revision of this comment said the
// mirrors were kept in lockstep "via the vendored golden fixtures"; no such
// shared fixture set exists — the Go package is plan.go + plan_test.go with
// inline JSON and no testdata directory, and no CI job anywhere runs the Go or
// jq summarizer over these vectors. Nothing detects a divergence today. See the
// "Cross-implementation obligation" section of SECURITY.md before relying on
// parity.
export {
  summarize,
  moduleCallsPlan,
  fmt,
  isSens,
  type Plan,
  type ResourceChange,
  type SummaryEntry,
  type AttrChange,
  type ModuleCallProvenance,
  type Result,
} from './summarize'
