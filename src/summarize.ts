// The canonical TSM drift summarizer — the single source of truth for parsing
// Terraform/OpenTofu plan JSON into the TSM drift callback payload. Consumed (and
// ncc-bundled) by the terraform-drift-report GitHub Action and the Azure DevOps
// TerraformDriftReport task, and mirrored by the backend's
// internal/services/driftingest (Go) and the jq in its dispatched CI templates.
//
// This file, together with __tests__/, IS the authority those two are diffed
// against. Earlier revisions described it as a port of a Python
// `drift_summary.py`; no such file exists anywhere in the suite, so that citation
// named nothing and has been removed (see SECURITY.md). Do not reintroduce it.
//
// The semantics the mirrors must match:
//   - skip resource changes whose actions are EXACTLY ["no-op"] or ["read"];
//   - counts are replace-aware and NOT mutually exclusive: a replacement
//     ["delete","create"] bumps BOTH added and destroyed (changed only on
//     "update"), matching terraform's "X to add, Y to change, Z to destroy";
//   - drifted = (added + changed + destroyed) > 0;
//   - for in-place updates/replaces (before & after both objects), emit `attrs`:
//     the top-level keys whose value differs, with before/after run through
//     fmt() (300-char truncation, U+2026 marker) and masked to the literal
//     "(sensitive)" when before_sensitive/after_sensitive marks them.
//
// terraform -json does NOT mask sensitive values (only human output does), so
// masking happens here, BEFORE fmt(), so secrets never reach the formatter.
//
// An attribute is masked when EITHER side marks it sensitive. This was a
// deliberate divergence when it landed in v1.1.0; the Go driftingest took the
// same union in terraform-state-manager-backend#374 and is now byte-identical
// here, so it is simply the contract. The jq path has no attribute values to
// mask — its summary is {address, actions} only. See SECURITY.md for the
// differences that do remain, none of which is a redaction gap.

export interface AttrChange {
  name: string
  /** fmt(value) | "(sensitive)" | null */
  before: string | null
  after: string | null
}

export interface SummaryEntry {
  address: string
  actions: string[]
  /** Present only on in-place updates/replaces with at least one changed key. */
  attrs?: AttrChange[]
}

export interface ResourceChange {
  address?: string
  change?: {
    actions?: string[]
    before?: unknown
    after?: unknown
    before_sensitive?: unknown
    after_sensitive?: unknown
  }
}

/** The subset of a `terraform show -json` / `tofu show -json` document we read. */
export interface Plan {
  resource_changes?: ResourceChange[]
  configuration?: {
    root_module?: {
      module_calls?: Record<string, unknown>
    }
  }
}

export interface Result {
  added: number
  changed: number
  destroyed: number
  drifted: boolean
  summary: SummaryEntry[]
}

/** Python `bool(x)` truthiness (empty dict/list/string → false), unlike JS. */
function pyBool(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false
  if (v === true) return true
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return Boolean(v)
}

/** Deterministic JSON with sorted keys + compact separators — matches python
 *  json.dumps(v, separators=(",",":"), sort_keys=True). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v as object).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}'
}

/** Deep equality for JSON values (key order independent), matching python `==`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

/** The canonical `fmt`: strings pass through raw, everything else is compact
 *  sorted JSON; truncate past 300 code points with U+2026. */
export function fmt(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v : stableStringify(v)
  const cps = Array.from(s) // code points, matching python len()/slice
  return cps.length <= 300 ? s : cps.slice(0, 300).join('') + '…'
}

/** The canonical `isSens`: before_sensitive/after_sensitive mirror the value
 *  shape; true (or a non-empty nested object/array) → mask. */
export function isSens(sens: unknown, k: string): boolean {
  if (typeof sens !== 'object' || sens === null || Array.isArray(sens)) {
    return pyBool(sens)
  }
  const sv = (sens as Record<string, unknown>)[k]
  return sv === true || (typeof sv === 'object' && sv !== null && pyBool(sv))
}

function has(actions: string[], action: string): boolean {
  return Array.isArray(actions) && actions.includes(action)
}

/** Exactly ["no-op"] or ["read"] — the only skipped action lists. */
function isSkipped(actions: string[]): boolean {
  return actions.length === 1 && (actions[0] === 'no-op' || actions[0] === 'read')
}

export function summarize(plan: Plan | null | undefined): Result {
  const summary: SummaryEntry[] = []
  let added = 0
  let changed = 0
  let destroyed = 0

  for (const c of plan?.resource_changes ?? []) {
    const ch = c.change ?? {}
    const actions = ch.actions ?? []
    if (isSkipped(actions)) continue

    const item: SummaryEntry = { address: c.address ?? '', actions }

    const before = ch.before
    const after = ch.after
    if (before !== null && typeof before === 'object' && !Array.isArray(before) &&
        after !== null && typeof after === 'object' && !Array.isArray(after)) {
      const bs = ch.before_sensitive ?? {}
      const as_ = ch.after_sensitive ?? {}
      const bObj = before as Record<string, unknown>
      const aObj = after as Record<string, unknown>
      const attrs: AttrChange[] = []
      for (const k of Array.from(new Set([...Object.keys(bObj), ...Object.keys(aObj)])).sort()) {
        if (jsonEqual(bObj[k], aObj[k])) continue
        // Union, not per-side: terraform applies a config-derived mark (a
        // `sensitive = true` variable, sensitive(), a sensitive module output)
        // to the PLANNED value only — it is never persisted to state — so a
        // credential routinely arrives marked on exactly one side. Masking each
        // side against its own mirror would emit the other side in cleartext
        // (the `~ user_data = "old-plaintext" -> (sensitive value)` shape).
        // Over-masking a symmetric pair costs nothing: both sides already
        // render "(sensitive)".
        const sensitive = isSens(bs, k) || isSens(as_, k)
        attrs.push({
          name: k,
          before: sensitive ? '(sensitive)' : fmt(bObj[k]),
          after: sensitive ? '(sensitive)' : fmt(aObj[k]),
        })
      }
      if (attrs.length > 0) item.attrs = attrs
    }

    summary.push(item)
    if (has(actions, 'create')) added++
    if (has(actions, 'update')) changed++
    if (has(actions, 'delete')) destroyed++
  }

  return { added, changed, destroyed, drifted: added + changed + destroyed > 0, summary }
}

/** Upper bound on the top-level module calls forwarded as provenance. A root
 *  module with more direct calls than this is pathological; the overflow is
 *  dropped and flagged rather than serialised. */
const MAX_MODULE_CALLS = 100

const REDACTED = '(redacted)'

/** Module provenance: exactly the two fields the backend's driftingest
 *  `Configuration` struct reads. Nothing else from the config is forwarded. */
export interface ModuleCallProvenance {
  source?: string
  version_constraint?: string
}

/** Removes credentials a module source address can carry. Two shapes:
 *   - URL userinfo — `git::https://x-access-token:ghp_…@github.com/org/mod.git`
 *     (all userinfo is redacted, including a bare `token@`; a username alone is
 *     a valid credential on GitHub/GitLab HTTPS);
 *   - query parameters — go-getter accepts credential-bearing ones
 *     (`sshkey=<base64 private key>`, S3 presigned `X-Amz-Signature=…`,
 *     `token=…`), so only `ref` (the git ref / version selector, the one
 *     provenance-bearing parameter) survives; every other value is redacted. */
function scrubModuleSource(src: string): string {
  let out = src.replace(/(:\/\/)[^/?#@]*@/, `$1${REDACTED}@`)
  const q = out.indexOf('?')
  if (q >= 0) {
    const params = out
      .slice(q + 1)
      .split('&')
      .map((p) => {
        const eq = p.indexOf('=')
        if (eq < 0 || p.slice(0, eq) === 'ref') return p
        return `${p.slice(0, eq)}=${REDACTED}`
      })
      .join('&')
    out = `${out.slice(0, q)}?${params}`
  }
  return out
}

/** Projects one `module_calls` entry down to provenance. Only string `source` /
 *  `version_constraint` survive, so `expressions` (every literal argument's
 *  `constant_value`), the recursive `module` subtree and any other member are
 *  dropped by construction — no nested value can ride along. */
function projectModuleCall(v: unknown): ModuleCallProvenance {
  const out: ModuleCallProvenance = {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  const call = v as Record<string, unknown>
  if (typeof call.source === 'string') out.source = fmt(scrubModuleSource(call.source)) as string
  if (typeof call.version_constraint === 'string') out.version_constraint = fmt(call.version_constraint) as string
  return out
}

/** Forwards `configuration.root_module.module_calls` for the optional
 *  module-provenance field the backend accepts on dispatched runs. Orthogonal to
 *  the summary, and not part of the count/skip semantics above.
 *
 *  The plan's `configuration` block carries NO terraform sensitivity metadata —
 *  before_sensitive/after_sensitive exist only inside `resource_changes` — so
 *  anything forwarded from it is unredacted by construction. The subtree is
 *  therefore projected, never forwarded verbatim: per call only `source` (with
 *  credentials scrubbed) and `version_constraint`, each capped by fmt() at 300
 *  code points like every other emitted value, and at most MAX_MODULE_CALLS
 *  entries (`module_calls_truncated: true` marks an overflow). The backend reads
 *  exactly these two fields (driftingest.Configuration), so the projection drops
 *  nothing any consumer uses. */
export function moduleCallsPlan(plan: Plan | null | undefined): unknown {
  const raw = plan?.configuration?.root_module?.module_calls
  const calls =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  // Null-prototype: a module named "__proto__" must land as an own property.
  const module_calls = Object.create(null) as Record<string, ModuleCallProvenance>
  const names = Object.keys(calls).sort()
  let truncated = names.length > MAX_MODULE_CALLS
  for (const name of names.slice(0, MAX_MODULE_CALLS)) {
    const key = fmt(name) as string
    if (key in module_calls) {
      truncated = true // two names collided after the 300-code-point cap
      continue
    }
    module_calls[key] = projectModuleCall(calls[name])
  }
  const root_module: Record<string, unknown> = { module_calls }
  if (truncated) root_module.module_calls_truncated = true
  return { configuration: { root_module } }
}
