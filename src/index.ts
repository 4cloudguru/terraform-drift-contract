// Public surface of the TSM drift contract. The single source of truth for the
// count/summary/attrs semantics shared by every drift consumer:
//   - the GitHub Action  (terraform-drift-report)
//   - the Azure DevOps task (TerraformDriftReport, initiative 6)
//   - mirrored by the backend's internal/services/driftingest (Go) and by the jq
//     in its dispatched CI templates, via the vendored golden fixtures. This
//     package (src/summarize.ts + __tests__/) is the authority they are diffed
//     against; see SECURITY.md.
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
