export interface AttrChange {
    /** The changed path: a top-level attribute name, followed by `.key`,
     *  `["key"]` or `[index]` segments when the change was expanded into the
     *  members of an object or array value. Never truncated. */
    name: string;
    /** fmt(value) | "(sensitive)" | null */
    before: string | null;
    after: string | null;
}
export interface SummaryEntry {
    address: string;
    actions: string[];
    /** Present only on in-place updates/replaces with at least one changed key. */
    attrs?: AttrChange[];
}
export interface ResourceChange {
    address?: string;
    change?: {
        actions?: string[];
        before?: unknown;
        after?: unknown;
        before_sensitive?: unknown;
        after_sensitive?: unknown;
    };
}
/** The subset of a `terraform show -json` / `tofu show -json` document we read. */
export interface Plan {
    resource_changes?: ResourceChange[];
    /** Infra drift: hand-edits or other out-of-band changes, as opposed to the
     *  unapplied config changes in `resource_changes` (e.g. from a
     *  `-refresh-only` plan or an equivalent drift-detection pass). Optional and
     *  additive — absent or malformed input reports zero drift counts and an
     *  empty `drift_summary` rather than affecting `resource_changes` handling
     *  in any way. Run through the identical skip/count/mask/bound rules as
     *  `resource_changes` — see `processChanges`. */
    resource_drift?: ResourceChange[];
    configuration?: {
        root_module?: {
            module_calls?: Record<string, unknown>;
        };
    };
}
/** Upper bounds on the summary. The 300-code-point cap in `fmt()` is per VALUE;
 *  without these there is no cap on the number of entries, on attrs per entry,
 *  or on total bytes, and the object below is what a consumer POSTs to the TSM
 *  callback, writes to a file on the runner and stores as a drift record.
 *  Measured before they existed: 1000 resources x 20 changed attrs produced a
 *  12.3 MiB body; 5000 x 50 produced 153.6 MiB. Both are authorable in a
 *  fork-PR config.
 *
 *  The numbers are part of the contract, not of this file: they are declared in
 *  `conformance/vectors.json` under `limits`, and every implementation asserts
 *  its own constants against that declaration. Changing one means changing the
 *  corpus, which means changing all of them. */
export declare const DEFAULT_MAX_ENTRIES = 500;
export declare const DEFAULT_MAX_ATTRS_PER_ENTRY = 50;
/** Caller overrides for the bounds above. Not part of the emitted payload, hence
 *  camelCase where `Result`'s wire fields are snake_case. */
export interface SummarizeOptions {
    /** Summary rows to emit. Counts are NOT capped — see `Result.omitted_entries`. */
    maxEntries?: number;
    /** `attrs` rows (changed paths) to emit per summary entry — see `Result.omitted_attrs`. */
    maxAttrsPerEntry?: number;
}
export interface Result {
    added: number;
    changed: number;
    destroyed: number;
    /** `added`/`changed`/`destroyed`, computed from `resource_drift` instead of
     *  `resource_changes` — infra drift rather than unapplied config changes.
     *  Same skip rules (exactly `["no-op"]` or `["read"]`) and the same
     *  `maxEntries`/`maxAttrsPerEntry` bounds, via the identical per-item logic
     *  (`processChanges`). Zero when `resource_drift` is absent or not an array.
     *  Purely additive: does not affect `drifted`, `summary`, or the three
     *  counts above. */
    drift_added: number;
    drift_changed: number;
    drift_destroyed: number;
    drifted: boolean;
    summary: SummaryEntry[];
    /** Parallel to `summary`, rendered from `resource_drift`. Empty when
     *  `resource_drift` is absent or not an array. Never influences `summary`
     *  itself. */
    drift_summary: SummaryEntry[];
    /** The document did not have the shape of a plan: it is not an object, or its
     *  `resource_changes` is absent or not an array.
     *
     *  Without this there was no signal at all distinguishing "verified clean"
     *  from "never actually ran the check": a truncated `terraform show -json`, a
     *  wrong file passed to the callback, an empty `{}` and a genuinely clean plan
     *  all produced the identical `drifted: false`. A CI gate or a TSM ingest that
     *  keys a pass/fail decision on `drifted` could not tell them apart, which is
     *  a false negative on this library's core signal. */
    unparseable: boolean;
    /** At least one non-skipped change would have emitted attribute values and
     *  carried NEITHER `before_sensitive` NOR `after_sensitive`, so nothing was
     *  masked for it — see the fail-open note at the top of this file.
     *
     *  Deliberately shape-based and therefore slightly over-broad: it is set for a
     *  change with no sensitivity metadata even if no key ended up differing. The
     *  jq mirror cannot diff, so an over-broad definition is the one all three
     *  implementations can compute identically — and over-warning is the right
     *  direction for a redaction signal. A present-but-false mirror is metadata,
     *  and does NOT set this. */
    unmasked: boolean;
    /** A bound was reached and the summary is not the whole story. */
    truncated: boolean;
    /** Summary rows dropped by `maxEntries`. The COUNTS still include them, so
     *  `drifted` stays truthful when the summary is capped. */
    omitted_entries: number;
    /** `attrs` rows (changed paths) dropped by `maxAttrsPerEntry`, across all entries. */
    omitted_attrs: number;
}
/** The canonical `fmt`: strings pass through raw, everything else is compact
 *  sorted JSON; truncate past 300 code points with U+2026. */
export declare function fmt(v: unknown): string | null;
/** The canonical `isSens`: whether the sensitivity mirror marks any part of the
 *  top-level key `k`. before_sensitive/after_sensitive mirror the value's shape,
 *  and a mark is a truthy scalar — terraform writes `true` — at any depth under
 *  `k`. A mirror that is not an object is the whole-value flag and marks every
 *  key when truthy.
 *
 *  A container with no truthy scalar in it is NOT a mark. Terraform writes one
 *  for every nested block and every list, sensitive or not: an azurerm 4.81
 *  `blob_properties` with nothing sensitive in it is
 *  `[{"container_delete_retention_policy":[{}],"cors_rule":[],"delete_retention_policy":[{}],"restore_policy":[]}]`,
 *  and a two-element `address_space` is `[false,false]`. Up to v1.4.2 a
 *  non-empty container masked the key, so every such attribute rendered
 *  `(sensitive) -> (sensitive)`.
 *
 *  True does not mean the whole attribute is masked: `summarize` masks the
 *  marked paths inside it, and emits the rest. See `walkAttr`. */
export declare function isSens(sens: unknown, k: string): boolean;
/** How far a changed attribute is expanded into per-path rows: at most this many
 *  path segments below the top-level key, and no row name longer than this many
 *  code points. Past either bound the node is emitted as one row holding its
 *  whole value. Contract numbers, declared in `conformance/vectors.json` under
 *  `limits` beside the summary bounds and asserted by every implementation.
 *
 *  The depth bound is also the cost bound: each expanded level serialises its
 *  members once more, so a value is serialised at most 1 + MAX_ATTR_PATH_DEPTH
 *  times however it nests. 16 covers the deepest blocks in common providers
 *  (azurerm blob_properties needs 4, an AWS WAF statement about 15). The name
 *  bound is needed because map keys are configuration data: a `tags` key can be
 *  any length, and a row name is never truncated (it is the row's identity). */
export declare const MAX_ATTR_PATH_DEPTH = 16;
export declare const MAX_ATTR_PATH_CODE_POINTS = 300;
/** Whether two values have the same canonical form — `stableStringify(x) ===
 *  stableStringify(y)`, which is the comparison every diff in this file makes —
 *  decided structurally, without building either string.
 *
 *  The walk compares the members of every expanded level, so building the
 *  strings cost one full serialisation of a value per level of nesting above it.
 *  A first version also kept them, for about 17 live copies of a deep value: a
 *  256 MiB plan aborted the process out of memory, which cannot be caught,
 *  before the drift callback fired. Building and dropping them still peaked at
 *  2.5x the memory and 25x the time of v1.4.2 on that plan.
 *
 *  It is exactly the string comparison, case by case, and a property test holds
 *  it to that: null, absent and a non-finite number (JSON.parse reads `1e400` as
 *  Infinity) all serialise as `null`; a finite number is its shortest
 *  round-trip form, unique per double, except that `-0` is kept apart from `0`;
 *  strings, booleans, arrays and objects compare as their JSON does, objects by
 *  own key set. Iterative, and it stops at the first difference. Exported from
 *  this module (not the package) for that test only. */
export declare function sameCanon(x: unknown, y: unknown): boolean;
export declare function summarize(plan: Plan | null | undefined, options?: SummarizeOptions): Result;
/** Module provenance: exactly the two fields the backend's driftingest
 *  `Configuration` struct reads. Nothing else from the config is forwarded. */
export interface ModuleCallProvenance {
    source?: string;
    version_constraint?: string;
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
export declare function moduleCallsPlan(plan: Plan | null | undefined): unknown;
