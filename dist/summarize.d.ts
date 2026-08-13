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
export interface Result {
    added: number;
    changed: number;
    destroyed: number;
    drifted: boolean;
    summary: SummaryEntry[];
}
/** The canonical `fmt`: strings pass through raw, everything else is compact
 *  sorted JSON; truncate past 300 code points with U+2026. */
export declare function fmt(v: unknown): string | null;
/** The canonical `isSens`: before_sensitive/after_sensitive mirror the value
 *  shape; true (or a non-empty nested object/array) → mask. */
export declare function isSens(sens: unknown, k: string): boolean;
export declare function summarize(plan: Plan | null | undefined): Result;
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
