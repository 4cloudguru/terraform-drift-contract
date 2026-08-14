export interface AttrChange {
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
    /** Changed attributes to emit per row — see `Result.omitted_attrs`. */
    maxAttrsPerEntry?: number;
}
export interface Result {
    added: number;
    changed: number;
    destroyed: number;
    drifted: boolean;
    summary: SummaryEntry[];
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
    /** Changed attributes dropped by `maxAttrsPerEntry`, across all rows. */
    omitted_attrs: number;
}
/** The canonical `fmt`: strings pass through raw, everything else is compact
 *  sorted JSON; truncate past 300 code points with U+2026. */
export declare function fmt(v: unknown): string | null;
/** The canonical `isSens`: before_sensitive/after_sensitive mirror the value
 *  shape; true (or a non-empty nested object/array) → mask. */
export declare function isSens(sens: unknown, k: string): boolean;
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
