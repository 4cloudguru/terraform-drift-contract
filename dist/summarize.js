"use strict";
// Canonical TypeScript port of the TSM drift summarizer (drift_summary.py) — the
// single source of truth for parsing Terraform/OpenTofu plan JSON into the TSM
// drift callback payload. Consumed (and ncc-bundled) by the terraform-drift-report
// GitHub Action and the Azure DevOps TerraformDriftReport task, and reconciled
// with the backend's internal/services/driftingest (Go).
//
// Semantics MUST match drift_summary.py exactly:
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
// DELIBERATE DIVERGENCE (see README "Contract divergences"): an attribute is
// masked when EITHER side marks it sensitive. drift_summary.py and the Go
// driftingest still mask each side against its own mirror, so for an
// asymmetrically marked attribute they emit the unmasked side verbatim while
// this implementation masks both. Every symmetric case stays byte-identical.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fmt = fmt;
exports.isSens = isSens;
exports.summarize = summarize;
exports.moduleCallsPlan = moduleCallsPlan;
/** Python `bool(x)` truthiness (empty dict/list/string → false), unlike JS. */
function pyBool(v) {
    if (v === null || v === undefined || v === false)
        return false;
    if (v === true)
        return true;
    if (typeof v === 'number')
        return v !== 0;
    if (typeof v === 'string')
        return v.length > 0;
    if (Array.isArray(v))
        return v.length > 0;
    if (typeof v === 'object')
        return Object.keys(v).length > 0;
    return Boolean(v);
}
/** Deterministic JSON with sorted keys + compact separators — matches python
 *  json.dumps(v, separators=(",",":"), sort_keys=True). */
function stableStringify(v) {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
/** Deep equality for JSON values (key order independent), matching python `==`. */
function jsonEqual(a, b) {
    return stableStringify(a) === stableStringify(b);
}
/** Verbatim port of drift_summary.py `fmt`: strings pass through raw, everything
 *  else is compact sorted JSON; truncate past 300 code points with U+2026. */
function fmt(v) {
    if (v === null || v === undefined)
        return null;
    const s = typeof v === 'string' ? v : stableStringify(v);
    const cps = Array.from(s); // code points, matching python len()/slice
    return cps.length <= 300 ? s : cps.slice(0, 300).join('') + '…';
}
/** Verbatim port of drift_summary.py `is_sens`: before_sensitive/after_sensitive
 *  mirror the value shape; True (or a non-empty nested dict/list) → mask. */
function isSens(sens, k) {
    if (typeof sens !== 'object' || sens === null || Array.isArray(sens)) {
        return pyBool(sens);
    }
    const sv = sens[k];
    return sv === true || (typeof sv === 'object' && sv !== null && pyBool(sv));
}
function has(actions, action) {
    return Array.isArray(actions) && actions.includes(action);
}
/** Exactly ["no-op"] or ["read"] — the only skipped action lists. */
function isSkipped(actions) {
    return actions.length === 1 && (actions[0] === 'no-op' || actions[0] === 'read');
}
function summarize(plan) {
    const summary = [];
    let added = 0;
    let changed = 0;
    let destroyed = 0;
    for (const c of plan?.resource_changes ?? []) {
        const ch = c.change ?? {};
        const actions = ch.actions ?? [];
        if (isSkipped(actions))
            continue;
        const item = { address: c.address ?? '', actions };
        const before = ch.before;
        const after = ch.after;
        if (before !== null && typeof before === 'object' && !Array.isArray(before) &&
            after !== null && typeof after === 'object' && !Array.isArray(after)) {
            const bs = ch.before_sensitive ?? {};
            const as_ = ch.after_sensitive ?? {};
            const bObj = before;
            const aObj = after;
            const attrs = [];
            for (const k of Array.from(new Set([...Object.keys(bObj), ...Object.keys(aObj)])).sort()) {
                if (jsonEqual(bObj[k], aObj[k]))
                    continue;
                // Union, not per-side: terraform applies a config-derived mark (a
                // `sensitive = true` variable, sensitive(), a sensitive module output)
                // to the PLANNED value only — it is never persisted to state — so a
                // credential routinely arrives marked on exactly one side. Masking each
                // side against its own mirror would emit the other side in cleartext
                // (the `~ user_data = "old-plaintext" -> (sensitive value)` shape).
                // Over-masking a symmetric pair costs nothing: both sides already
                // render "(sensitive)".
                const sensitive = isSens(bs, k) || isSens(as_, k);
                attrs.push({
                    name: k,
                    before: sensitive ? '(sensitive)' : fmt(bObj[k]),
                    after: sensitive ? '(sensitive)' : fmt(aObj[k]),
                });
            }
            if (attrs.length > 0)
                item.attrs = attrs;
        }
        summary.push(item);
        if (has(actions, 'create'))
            added++;
        if (has(actions, 'update'))
            changed++;
        if (has(actions, 'delete'))
            destroyed++;
    }
    return { added, changed, destroyed, drifted: added + changed + destroyed > 0, summary };
}
/** Upper bound on the top-level module calls forwarded as provenance. A root
 *  module with more direct calls than this is pathological; the overflow is
 *  dropped and flagged rather than serialised. */
const MAX_MODULE_CALLS = 100;
const REDACTED = '(redacted)';
/** Removes credentials a module source address can carry. Two shapes:
 *   - URL userinfo — `git::https://x-access-token:ghp_…@github.com/org/mod.git`
 *     (all userinfo is redacted, including a bare `token@`; a username alone is
 *     a valid credential on GitHub/GitLab HTTPS);
 *   - query parameters — go-getter accepts credential-bearing ones
 *     (`sshkey=<base64 private key>`, S3 presigned `X-Amz-Signature=…`,
 *     `token=…`), so only `ref` (the git ref / version selector, the one
 *     provenance-bearing parameter) survives; every other value is redacted. */
function scrubModuleSource(src) {
    let out = src.replace(/(:\/\/)[^/?#@]*@/, `$1${REDACTED}@`);
    const q = out.indexOf('?');
    if (q >= 0) {
        const params = out
            .slice(q + 1)
            .split('&')
            .map((p) => {
            const eq = p.indexOf('=');
            if (eq < 0 || p.slice(0, eq) === 'ref')
                return p;
            return `${p.slice(0, eq)}=${REDACTED}`;
        })
            .join('&');
        out = `${out.slice(0, q)}?${params}`;
    }
    return out;
}
/** Projects one `module_calls` entry down to provenance. Only string `source` /
 *  `version_constraint` survive, so `expressions` (every literal argument's
 *  `constant_value`), the recursive `module` subtree and any other member are
 *  dropped by construction — no nested value can ride along. */
function projectModuleCall(v) {
    const out = {};
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return out;
    const call = v;
    if (typeof call.source === 'string')
        out.source = fmt(scrubModuleSource(call.source));
    if (typeof call.version_constraint === 'string')
        out.version_constraint = fmt(call.version_constraint);
    return out;
}
/** Forwards `configuration.root_module.module_calls` for the optional
 *  module-provenance field the backend accepts on dispatched runs. Not part of
 *  drift_summary.py (which omits provenance); orthogonal to the summary.
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
function moduleCallsPlan(plan) {
    const raw = plan?.configuration?.root_module?.module_calls;
    const calls = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    // Null-prototype: a module named "__proto__" must land as an own property.
    const module_calls = Object.create(null);
    const names = Object.keys(calls).sort();
    let truncated = names.length > MAX_MODULE_CALLS;
    for (const name of names.slice(0, MAX_MODULE_CALLS)) {
        const key = fmt(name);
        if (key in module_calls) {
            truncated = true; // two names collided after the 300-code-point cap
            continue;
        }
        module_calls[key] = projectModuleCall(calls[name]);
    }
    const root_module = { module_calls };
    if (truncated)
        root_module.module_calls_truncated = true;
    return { configuration: { root_module } };
}
