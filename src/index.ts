// Public surface of the TSM drift contract. The single source of truth for the
// count/summary/attrs semantics shared by every drift consumer:
//   - the GitHub Action  (terraform-drift-report)
//   - the Azure DevOps task (TerraformDriftReport, initiative 6)
//   - reconciled with the backend's internal/services/driftingest (Go) and the
//     dispatch summarizer drift_summary.py, via the vendored golden fixtures.
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
