"use strict";
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
//     one row per changed PATH. A top-level key whose values differ is one row,
//     unless both sides are objects, or arrays of one length — then each
//     differing member is its own row, recursively, named like a terraform
//     path (`tags.COST_CENTER`, `blob_properties[0].delete_retention_policy[0].days`,
//     `tags["kubernetes.io/role"]`) — bounded by MAX_ATTR_PATH_DEPTH and
//     MAX_ATTR_PATH_CODE_POINTS (see `walkAttr`). before/after are run through
//     fmt() (300-char truncation, U+2026 marker) and masked to the literal
//     "(sensitive)" when before_sensitive/after_sensitive marks that path;
//   - the top-level `timeouts` key is not a change when BOTH sides are
//     null-equivalent (null, absent, or a non-empty object/list of nulls) — see
//     `nullEquivalent`. Every other key compares by value alone.
//
// terraform -json does NOT mask sensitive values (only human output does), so
// masking happens here, BEFORE fmt(), so a marked secret never reaches the
// formatter.
//
// A path is masked when a mirror holds a truthy scalar (terraform writes `true`)
// at it, above it or below it — see `marks` and `covers`. An empty container is
// not a mark, and neither is a container of `false`s or `{}`s, which terraform
// writes for every nested block and list whether or not anything in it is
// sensitive: until v1.5.0 any non-empty container masked the whole top-level
// key, so `blob_properties` and `address_space` rendered `(sensitive)` with
// nothing sensitive in them (Brunswick fleet, 2026-10-22). A value a mirror
// marks anywhere in the change is also masked wherever else it appears in it —
// see `MarkedValues`: marks follow paths, and values move between them.
//
// ONE PRECONDITION on that, load-bearing and not optional: it is driven
// ENTIRELY by that metadata. When a plan carries neither mirror, nothing is
// masked for that resource. That is deliberate and fail-open (masking it would
// mask every attribute of every such plan, and would diverge from the Go mirror,
// which fails open identically); it is pinned by a test row and documented in
// SECURITY.md. It is NOT a guarantee that holds for plans of unknown provenance.
// A secret that neither mirror marks, at its path or elsewhere in the change, is
// emitted, at any depth.
//
// An attribute is masked when EITHER side marks it sensitive. This was a
// deliberate divergence when it landed in v1.1.0; the Go driftingest took the
// same union in terraform-state-manager-backend#374 and is now byte-identical
// here, so it is simply the contract. The jq path has no attribute values to
// mask — its summary is {address, actions} only. See SECURITY.md for the
// differences that do remain, none of which is a redaction gap.
//
// `resource_drift` (optional) is infra drift — hand-edits or other out-of-band
// changes — as distinct from the unapplied config changes in
// `resource_changes`. It is run through the identical rules above (skip,
// counts, attrs, masking, bounds) via the shared `processChanges`, and reports
// through the parallel `drift_added`/`drift_changed`/`drift_destroyed`/
// `drift_summary` fields. It is purely additive: absent or malformed input
// reports zero drift and never affects `resource_changes` handling, `drifted`,
// or `summary`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ATTR_PATH_CODE_POINTS = exports.MAX_ATTR_PATH_DEPTH = exports.DEFAULT_MAX_ATTRS_PER_ENTRY = exports.DEFAULT_MAX_ENTRIES = void 0;
exports.fmt = fmt;
exports.isSens = isSens;
exports.sameCanon = sameCanon;
exports.summarize = summarize;
exports.moduleCallsPlan = moduleCallsPlan;
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
exports.DEFAULT_MAX_ENTRIES = 500;
exports.DEFAULT_MAX_ATTRS_PER_ENTRY = 50;
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
/** Orders two strings by CODE POINT, not by UTF-16 code unit.
 *
 *  `Array.prototype.sort()`'s default comparator compares code units, so a
 *  surrogate pair (lead unit 0xD800–0xDBFF) sorts *below* every unpaired unit
 *  from 0xE000 up: `["￿", "\u{1F600}"].sort()` puts the emoji first, where
 *  a code-point sort puts it last. The Go mirror sorts map keys as UTF-8 bytes
 *  and jq sorts by code point — both of which ARE code-point order — so the
 *  default comparator was the one implementation out of three, and map keys are
 *  attacker-influenceable (a `tags` block with an emoji key is legal HCL). This
 *  is the sort used everywhere a key set is emitted. */
function compareCodePoints(a, b) {
    const ai = a[Symbol.iterator]();
    const bi = b[Symbol.iterator]();
    for (;;) {
        const x = ai.next();
        const y = bi.next();
        if (x.done)
            return y.done ? 0 : -1;
        if (y.done)
            return 1;
        if (x.value !== y.value) {
            return x.value.codePointAt(0) < y.value.codePointAt(0) ? -1 : 1;
        }
    }
}
/** A JSON string literal, with U+2028/U+2029 escaped.
 *
 *  `JSON.stringify` leaves LINE SEPARATOR and PARAGRAPH SEPARATOR raw; Go's
 *  `encoding/json` escapes both unconditionally, and unlike its HTML escaping
 *  there is no encoder flag to turn that off. Escaping here is therefore the
 *  only direction that reconciles the two, and it is also the safer one: raw
 *  U+2028 terminates a line in a JS context, so a value carrying one can break
 *  out of a report embedded in a script. Applied to keys as well as values,
 *  because Go escapes both. */
function jsonString(s) {
    return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
/** Deterministic JSON with sorted keys and compact separators.
 *
 *  This is the canonical serialized form for every non-string attribute value,
 *  and it is what the Go `driftingest` mirror's `canon()` must reproduce
 *  byte-for-byte. An earlier revision of this comment claimed it matched
 *  `json.dumps(v, separators=(",",":"), sort_keys=True)`; it does not, and the
 *  Python file that claim pointed at never existed (see SECURITY.md).
 *
 *  The form, written down so a porter can reproduce it rather than infer it:
 *    - non-ASCII is emitted RAW (`"café"`), never `\uXXXX`-escaped;
 *    - `<`, `>` and `&` are emitted RAW (Go's encoding/json HTML-escapes them by
 *      default, so the mirror must use an encoder with `SetEscapeHTML(false)`);
 *    - U+2028 and U+2029 ARE escaped, in keys and in values (Go escapes them
 *      unconditionally and offers no flag, so this side moved);
 *    - keys sort by CODE POINT (see compareCodePoints);
 *    - negative zero is emitted as `-0`, not `0`. `JSON.stringify(-0)` yields
 *      `"0"`, which both loses the sign Terraform reported and makes `0` and
 *      `-0` compare EQUAL here while the Go mirror reports them as a change;
 *    - numbers are otherwise JS/Go shortest-round-trip doubles, which agree —
 *      including the >2^53 collapse (#18), verified across the corpus.
 *  Every one of those points has a conformance vector; the byte-level agreement
 *  with the mirror is asserted by the conformance runner, not by this comment.
 *
 *  `undefined` canonicalises to `"null"`, matching the Go mirror's `canon()`,
 *  which maps both an absent key and an explicit null to `"null"` — without it
 *  this function returns the VALUE undefined and its `: string` signature is a
 *  runtime lie. */
function stableStringify(v) {
    // ITERATIVE, not recursive, and that is the point rather than a style choice.
    // The recursive form threw `RangeError: Maximum call stack size exceeded` at
    // roughly 2,600 levels of object nesting and 3,124 of array nesting, out of
    // summarize() and into the consumer's CI step, with no try/catch and no
    // exported error type. JSON.parse accepts documents ~300x deeper, so there was
    // a wide band in which a consumer parsed a plan successfully and then this
    // library exploded — and the crash lands BEFORE the drift callback fires, so
    // one deeply nested attribute value in a fork-PR config suppressed drift
    // reporting for the whole run. That is a detection-evasion primitive against a
    // security control, not a robustness nit.
    //
    // No depth LIMIT is imposed, deliberately: a limit needs the same number in
    // every implementation, and the Go mirror's cap is encoding/json's own 10,000
    // (which rejects the whole document at the unmarshal boundary, so /drift/ingest
    // answers 422 rather than emitting a sentinel). Any invented limit here would
    // agree with neither. What matters is that no depth can make this throw.
    //
    // The stack holds work items LIFO, so children are pushed in reverse to pop in
    // order. Peak memory is O(nodes) rather than O(depth), which JSON.parse has
    // already paid for the same document.
    const out = [];
    const stack = [{ val: v }];
    while (stack.length > 0) {
        const w = stack.pop();
        if ('lit' in w) {
            out.push(w.lit);
            continue;
        }
        const x = w.val;
        if (x === undefined) {
            out.push('null');
        }
        else if (typeof x === 'string') {
            out.push(jsonString(x));
        }
        else if (Object.is(x, -0)) {
            out.push('-0');
        }
        else if (x === null || typeof x !== 'object') {
            out.push(JSON.stringify(x));
        }
        else if (Array.isArray(x)) {
            stack.push({ lit: ']' });
            for (let i = x.length - 1; i >= 0; i--) {
                stack.push({ val: x[i] });
                if (i > 0)
                    stack.push({ lit: ',' });
            }
            stack.push({ lit: '[' });
        }
        else {
            const o = x;
            const keys = Object.keys(o).sort(compareCodePoints);
            stack.push({ lit: '}' });
            for (let i = keys.length - 1; i >= 0; i--) {
                stack.push({ val: o[keys[i]] });
                stack.push({ lit: jsonString(keys[i]) + ':' });
                if (i > 0)
                    stack.push({ lit: ',' });
            }
            stack.push({ lit: '{' });
        }
    }
    return out.join('');
}
/** The 300-code-point cap applied by `fmt`. */
function truncate(s) {
    // A UTF-16 length <= 300 implies a code-point length <= 300 (a code point is
    // never fewer than one unit), so this returns exactly what the path below
    // would — without allocating one JS string per code point for a value we are
    // about to keep at most 300 of. The old unconditional Array.from() cost ~22x
    // the input in peak heap: 1.4 GiB for a single 64 MiB attribute value.
    if (s.length <= 300)
        return s;
    // Past that, bound the array work instead of materialising the whole value.
    // 301 code points — all the decision below needs — occupy at most 602 UTF-16
    // units, so 1200 always contains them. A surrogate pair split at the slice
    // boundary lands beyond index 300 and is discarded either way.
    const cps = Array.from(s.slice(0, 1200)); // code points, not UTF-16 units
    return cps.length <= 300 ? s : cps.slice(0, 300).join('') + '…';
}
/** The canonical `fmt`: strings pass through raw, everything else is compact
 *  sorted JSON; truncate past 300 code points with U+2026. */
function fmt(v) {
    if (v === null || v === undefined)
        return null;
    return truncate(typeof v === 'string' ? v : stableStringify(v));
}
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
function isSens(sens, k) {
    return marks(mirrorFor(sens, k));
}
/** The mirror node for top-level key `k`: own member `k` of an object mirror,
 *  or, for a whole-value flag, that flag's truthiness applied to every key.
 *
 *  hasOwnProperty (through `own`), not a bare read: `sens[k]` consults
 *  Object.prototype, so any other package sharing the process could influence
 *  the central predicate of a redaction control by writing to it. Pollution can
 *  only ever OVER-mask here, because an own JSON property always shadows an
 *  inherited one, so this is hardening rather than a disclosure fix — but a
 *  redaction predicate should not be one prototype read away from another
 *  package's state, and both consumers bundle this alongside other code. */
function mirrorFor(sens, k) {
    if (kindOf(sens) !== 'object')
        return pyBool(sens);
    return own(sens, k);
}
function kindOf(v) {
    if (Array.isArray(v))
        return 'array';
    return v !== null && typeof v === 'object' ? 'object' : 'scalar';
}
/** A mirror subtree marks its value when it holds a truthy scalar anywhere —
 *  Python truthiness, as for the whole-value flag. Terraform only ever writes
 *  `true`; reading any truthy scalar as a mark is the fail-closed reading of a
 *  mirror that is not terraform's (up to v1.4.2 `{"pw":"yes"}` masked nothing).
 *
 *  Iterative for the reason `stableStringify` is: the mirror is as
 *  attacker-influenced as the value, and no depth may make this throw. */
function marks(m) {
    const stack = [m];
    while (stack.length > 0) {
        const x = stack.pop();
        if (x !== null && typeof x === 'object') {
            for (const c of Array.isArray(x) ? x : Object.values(x))
                stack.push(c);
        }
        else if (pyBool(x)) {
            return true;
        }
    }
    return false;
}
/** The mirror node `m` masks ALL of value `v`, not a part of it: a truthy scalar
 *  (terraform's mark on a whole value, block or collection), or a mark under a
 *  mirror whose shape is not the value's. The second case is not terraform
 *  output; it cannot be aligned with the value member by member, so it is
 *  applied to the whole of it rather than lost by the walk below. */
function covers(m, v) {
    const mk = kindOf(m);
    if (mk === 'scalar')
        return pyBool(m);
    return mk !== kindOf(v) && marks(m);
}
/** The mirror node for one member of a container value of kind `kind`. A mirror
 *  of another shape has no aligned member, so it yields undefined — which is
 *  safe only because `covers` has already masked the whole value whenever such
 *  a mirror marks anything. An index past a mirror array's end is undefined
 *  rather than a prototype read. */
function mirrorChild(m, kind, key) {
    if (kind === 'array') {
        return Array.isArray(m) && key < m.length ? m[key] : undefined;
    }
    return kindOf(m) === 'object' ? own(m, key) : undefined;
}
/** An own-property read. A bare `o[k]` walks the prototype chain, which for the
 *  literal key `__proto__` yields Object.prototype instead of undefined. */
function own(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
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
exports.MAX_ATTR_PATH_DEPTH = 16;
exports.MAX_ATTR_PATH_CODE_POINTS = 300;
/** A terraform identifier, rendered as `.key`. Every other key is rendered as a
 *  quoted index, `["key"]`, so a name parses back to one path: `.` and `[` never
 *  appear in a dotted segment, and a quoted one is a JSON string literal. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function keySegment(k) {
    return IDENTIFIER.test(k) ? `.${k}` : `[${jsonString(k)}]`;
}
/** Code points in `s`, counted only as far as the 300 bound needs: a UTF-16
 *  length within it is within it in code points, and a code point is at most two
 *  units, so a length past twice it is past it. */
function withinNameBound(s) {
    if (s.length <= exports.MAX_ATTR_PATH_CODE_POINTS)
        return true;
    if (s.length > 2 * exports.MAX_ATTR_PATH_CODE_POINTS)
        return false;
    let n = 0;
    for (const _ of s)
        if (++n > exports.MAX_ATTR_PATH_CODE_POINTS)
            return false;
    return true;
}
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
function sameCanon(x, y) {
    const stack = [[x, y]];
    while (stack.length > 0) {
        const [a, b] = stack.pop();
        const kind = canonKind(a);
        if (kind !== canonKind(b))
            return false;
        switch (kind) {
            case 'null':
                break;
            case 'number':
                if (!Object.is(a, b))
                    return false;
                break;
            case 'array': {
                const aa = a;
                const ba = b;
                if (aa.length !== ba.length)
                    return false;
                for (let i = 0; i < aa.length; i++)
                    stack.push([aa[i], ba[i]]);
                break;
            }
            case 'object': {
                const ao = a;
                const bo = b;
                const keys = Object.keys(ao);
                if (keys.length !== Object.keys(bo).length)
                    return false;
                for (const k of keys) {
                    if (!Object.prototype.hasOwnProperty.call(bo, k))
                        return false;
                    stack.push([ao[k], bo[k]]);
                }
                break;
            }
            case 'other':
                // Nothing JSON.parse produces; fall back to the definition itself.
                if (stableStringify(a) !== stableStringify(b))
                    return false;
                break;
            default:
                // string, boolean
                if (a !== b)
                    return false;
        }
    }
    return true;
}
/** The class `stableStringify` serialises a value in, for `sameCanon`. */
function canonKind(v) {
    if (v === null || v === undefined)
        return 'null';
    if (typeof v === 'number')
        return Number.isFinite(v) ? 'number' : 'null';
    if (typeof v === 'string')
        return 'string';
    if (typeof v === 'boolean')
        return 'boolean';
    if (Array.isArray(v))
        return 'array';
    return typeof v === 'object' ? 'object' : 'other';
}
/** The members of `b`/`a` whose values differ, or null when the pair is not
 *  expanded: they are not both objects or both arrays of one length, nothing
 *  differs member by member (the difference is a null member against an absent
 *  one, which only the whole value shows), a member's name is past the bound, or
 *  a member's KEY is a marked value (see `MarkedValues`), which a row name would
 *  carry out in the clear.
 *
 *  Absent and null are the same member value, exactly as for top-level keys;
 *  object members are read own-only and in code-point order, for the reasons
 *  given at the top-level loop. */
function differingMembers(name, b, a, marked) {
    const kind = kindOf(b);
    if (kind === 'scalar' || kind !== kindOf(a))
        return null;
    const out = [];
    if (kind === 'array') {
        const ba = b;
        const aa = a;
        if (ba.length !== aa.length)
            return null;
        for (let i = 0; i < ba.length; i++) {
            if (sameCanon(ba[i], aa[i]))
                continue;
            const childName = `${name}[${i}]`;
            if (!withinNameBound(childName))
                return null;
            out.push({ key: i, name: childName, b: ba[i], a: aa[i] });
        }
    }
    else {
        const bo = b;
        const ao = a;
        for (const k of Array.from(new Set([...Object.keys(bo), ...Object.keys(ao)])).sort(compareCodePoints)) {
            const bv = own(bo, k);
            const av = own(ao, k);
            if (sameCanon(bv, av))
                continue;
            const childName = name + keySegment(k);
            if (!withinNameBound(childName) || isMarked(marked, k))
                return null;
            out.push({ key: k, name: childName, b: bv, a: av });
        }
    }
    return out.length > 0 ? out : null;
}
/** The `MarkedValues` entry for a scalar or a map key, or null when it holds none. */
function markedKey(v) {
    if (typeof v === 'string')
        return v.length > 0 ? `s${v}` : null;
    if (typeof v === 'number')
        return `n${stableStringify(v)}`;
    return null;
}
function isMarked(marked, v) {
    const mk = markedKey(v);
    return mk !== null && marked.has(mk);
}
/** Adds what `mirror` marks under `value` — same path, either side's mirror —
 *  to `marked`. Walks only where the mirror is a container of the value's kind,
 *  by the mirror's own members, so it costs the size of the mirror plus that of
 *  the values it covers. Iterative: both are attacker-influenced. */
function collectMarked(marked, value, mirror) {
    const stack = [[value, mirror]];
    while (stack.length > 0) {
        const [v, m] = stack.pop();
        if (covers(m, v)) {
            addAllValues(marked, v);
            continue;
        }
        // Not covered: a mirror of another shape holds no mark, and a scalar
        // mirror is falsy, so nothing under this value is marked.
        const kind = kindOf(v);
        if (kind === 'scalar' || kindOf(m) !== kind)
            continue;
        if (kind === 'array') {
            const va = v;
            const ma = m;
            for (let i = 0; i < Math.min(va.length, ma.length); i++)
                stack.push([va[i], ma[i]]);
        }
        else {
            const vo = v;
            const mo = m;
            for (const k of Object.keys(mo))
                if (Object.prototype.hasOwnProperty.call(vo, k))
                    stack.push([vo[k], mo[k]]);
        }
    }
}
/** Adds every scalar and every map key under `v` to `marked`. Iterative. */
function addAllValues(marked, v) {
    const stack = [v];
    while (stack.length > 0) {
        const x = stack.pop();
        if (x !== null && typeof x === 'object') {
            if (Array.isArray(x)) {
                for (const c of x)
                    stack.push(c);
            }
            else {
                for (const k of Object.keys(x)) {
                    const mk = markedKey(k);
                    if (mk !== null)
                        marked.add(mk);
                    stack.push(x[k]);
                }
            }
        }
        else {
            const mk = markedKey(x);
            if (mk !== null)
                marked.add(mk);
        }
    }
}
/** Whether any scalar or map key under `v` is a marked value. Iterative. */
function holdsMarked(marked, v) {
    if (marked.size === 0)
        return false;
    const stack = [v];
    while (stack.length > 0) {
        const x = stack.pop();
        if (x !== null && typeof x === 'object') {
            if (Array.isArray(x)) {
                for (const c of x)
                    stack.push(c);
            }
            else {
                for (const k of Object.keys(x)) {
                    if (isMarked(marked, k))
                        return true;
                    stack.push(x[k]);
                }
            }
        }
        else if (isMarked(marked, x)) {
            return true;
        }
    }
    return false;
}
/** Emits the rows for one changed value at path `name`, given the before and
 *  after mirror nodes at that same path (`mb` aligned with `b`, `ma` with `a`).
 *
 *  A node becomes ONE row when a mirror covers it — masked — or when it is not
 *  expanded (see `differingMembers`, and the depth bound) — masked if either
 *  mirror marks anything under it. Otherwise each differing member is walked as
 *  its own row, in member order, so a re-tag reports `tags.COST_CENTER` and a
 *  retention change reports `blob_properties[0].delete_retention_policy[0].days`
 *  instead of two 300-code-point prefixes of the whole value.
 *
 *  The union rule holds at every node: both sides are masked when either
 *  mirror covers or marks it. Every value reaches the output inside exactly one
 *  row, at its own path or an ancestor's, and that row is masked whenever a mark
 *  sits at, above or below that path in either mirror — above because the
 *  ancestor was covered, below because `marks` reads the whole subtree — and
 *  whenever it holds a value marked anywhere else in the change (`MarkedValues`).
 *  A walked node always yields at least one row, so a top-level key reported
 *  before is still reported.
 *
 *  Recursive, unlike the serializer: MAX_ATTR_PATH_DEPTH bounds the depth. */
function walkAttr(sink, name, b, a, mb, ma, depth) {
    if (covers(mb, b) || covers(ma, a)) {
        emitAttr(sink, name, true, b, a);
        return;
    }
    const members = depth < exports.MAX_ATTR_PATH_DEPTH ? differingMembers(name, b, a, sink.marked) : null;
    if (members === null) {
        emitAttr(sink, name, marks(mb) || marks(ma), b, a);
        return;
    }
    const kind = kindOf(b);
    for (const m of members) {
        walkAttr(sink, m.name, m.b, m.a, mirrorChild(mb, kind, m.key), mirrorChild(ma, kind, m.key), depth + 1);
    }
}
/** One row, or one omitted row past the cap. Past it the row is still known to
 *  have CHANGED, so it is counted, not concealed; only the formatting is skipped.
 *  The mask runs before the formatter, so a masked value never reaches it. */
function emitAttr(sink, name, masked, b, a) {
    if (sink.attrs.length >= sink.max) {
        sink.omitted++;
        return;
    }
    const sensitive = masked || holdsMarked(sink.marked, b) || holdsMarked(sink.marked, a);
    sink.attrs.push({
        name,
        before: sensitive ? SENSITIVE : fmt(b),
        after: sensitive ? SENSITIVE : fmt(a),
    });
}
const SENSITIVE = '(sensitive)';
/** The one top-level key `nullEquivalent` is applied to. */
const TIMEOUTS_KEY = 'timeouts';
/** Null, absent, or a NON-EMPTY object or array whose every member is itself
 *  null or null-equivalent: a value that carries no value anywhere in it.
 *
 *  An empty object or array is NOT null-equivalent. Plan JSON drops an unknown
 *  object member and writes an unknown list element as null, so an empty object
 *  on the `after` side can be an object whose every member is known only after
 *  apply, and terraform itself treats `[]` and null as different values.
 *
 *  Iterative for the reason `stableStringify` is: the value is
 *  attacker-influenced, and no depth may make this throw. */
function nullEquivalent(v) {
    const stack = [v];
    while (stack.length > 0) {
        const x = stack.pop();
        if (x === null || x === undefined)
            continue;
        if (typeof x !== 'object')
            return false;
        const members = Array.isArray(x) ? x : Object.values(x);
        if (members.length === 0)
            return false;
        for (const m of members)
            stack.push(m);
    }
    return true;
}
function has(actions, action) {
    return Array.isArray(actions) && actions.includes(action);
}
/** Exactly ["no-op"] or ["read"] — the only skipped action lists. */
function isSkipped(actions) {
    return actions.length === 1 && (actions[0] === 'no-op' || actions[0] === 'read');
}
/** The per-item loop: count, skip, mask and bound. Extracted so
 *  `resource_changes` and `resource_drift` run through the IDENTICAL logic
 *  rather than a parallel copy — a second copy is exactly how the two paths
 *  would drift apart, which is the bug the drift-count feature exists to
 *  avoid. `changes` must already be normalised to an array (see the call
 *  sites in `summarize`); this function does not itself decide what counts as
 *  "absent". */
function processChanges(changes, maxEntries, maxAttrsPerEntry) {
    const summary = [];
    let added = 0;
    let changed = 0;
    let destroyed = 0;
    let unmasked = false;
    let omittedEntries = 0;
    let omittedAttrs = 0;
    for (const c of changes) {
        // A null or primitive entry is valid JSON; reading `.change` off it throws.
        if (c === null || typeof c !== 'object' || Array.isArray(c))
            continue;
        // `?? {}` is sufficient here and no type check is added: only null and
        // undefined throw on a property read, and reading `.actions` off a string or
        // a number auto-boxes to undefined, which the normalisation below turns into
        // []. A type check was written here first and mutation testing proved it
        // inert — no input reached it — so it was removed rather than left in place
        // looking like a guard.
        const ch = c.change ?? {};
        // A malformed action list degrades to an uncounted-but-PRESENT entry rather
        // than a silently dropped one: dropping it conceals drift, and emitting the
        // raw value puts a non-array in a field `SummaryEntry` declares `string[]`,
        // which makes the Go driftingest reject the whole POST rather than one row.
        const actions = Array.isArray(ch.actions) ? ch.actions.filter((a) => typeof a === 'string') : [];
        if (isSkipped(actions))
            continue;
        // Counted BEFORE the entry cap, so a capped summary still reports drift
        // truthfully: `drifted` and the counts are the security signal, the summary
        // rows are the detail. Dropping a count to bound a payload would turn a size
        // limit into a missed detection.
        if (has(actions, 'create'))
            added++;
        if (has(actions, 'update'))
            changed++;
        if (has(actions, 'delete'))
            destroyed++;
        const before = ch.before;
        const after = ch.after;
        const inPlace = before !== null && typeof before === 'object' && !Array.isArray(before) &&
            after !== null && typeof after === 'object' && !Array.isArray(after);
        // Shape-based, and evaluated for capped entries too: this says "a change
        // that would emit attribute values carried no sensitivity metadata at all",
        // which is a property of the PLAN, not of how much of it fit in the summary.
        // No `const` binding for the mirrors here — the guard below is the masking
        // decision, and this is only a report about it.
        if (inPlace && ch.before_sensitive == null && ch.after_sensitive == null)
            unmasked = true;
        if (summary.length >= maxEntries) {
            omittedEntries++;
            continue;
        }
        // Type check only, deliberately NOT truncated: the address is the summary's
        // primary key — how a drift record is matched to a resource by the backend,
        // the Action and the ADO task — so capping it would break record identity.
        // That residual is documented in SECURITY.md.
        const item = { address: typeof c.address === 'string' ? c.address : '', actions };
        if (inPlace) {
            const bs = ch.before_sensitive ?? {};
            const as_ = ch.after_sensitive ?? {};
            const bObj = before;
            const aObj = after;
            // Code-point order, not the default code-unit order: this is the order the
            // `attrs` array is emitted in, and the Go mirror's `sortedUnion` sorts
            // UTF-8 bytes — which is code-point order. See compareCodePoints.
            const keys = Array.from(new Set([...Object.keys(bObj), ...Object.keys(aObj)])).sort(compareCodePoints);
            // Every value either mirror marks, on either side, at the same path —
            // including attributes that did not change, since a marked value can turn
            // up in one that did. See MarkedValues.
            const marked = new Set();
            for (const k of keys) {
                for (const m of [mirrorFor(bs, k), mirrorFor(as_, k)]) {
                    collectMarked(marked, own(bObj, k), m);
                    collectMarked(marked, own(aObj, k), m);
                }
            }
            const changedKeys = [];
            for (const k of keys) {
                // The key set is the UNION, so one side is routinely missing the key —
                // and a bare `[k]` read on that side walks its prototype chain. For every
                // ordinary key that is undefined either way; for the literal key
                // `__proto__` it returns Object.prototype, which serialises as `{}`. A
                // removed `__proto__` attribute therefore compared EQUAL to an empty
                // object and was silently dropped from attrs, and a present one reported
                // the counterpart as `"{}"` where the truthful answer is null. Own reads
                // restore absent → null, which is also what the Go mirror's map lookup
                // yields. Only reachable from a hand-crafted plan or a custom provider,
                // but concealing a diff is the wrong direction to fail in.
                const bv = own(bObj, k);
                const av = own(aObj, k);
                // Comparing the CANONICAL forms (not the raw strings) is what keeps the
                // string "1" distinct from the number 1. A row that is emitted whole is
                // serialised again by `fmt`; holding the canonical forms instead cost
                // more memory than the second pass costs time (see sameCanon).
                if (sameCanon(bv, av))
                    continue;
                // `timeouts` is terraform-plugin-sdk's operation-timeouts meta-attribute,
                // not resource state: the SDK keeps it out of the attribute diff and
                // copies the configured value into the planned state. So a state can
                // carry the unconfigured block as an object of nulls
                // (`{"create":null,"delete":null,"read":null,"update":null}`) while the
                // plan's `after` has null. On its own that difference plans no change,
                // yet this loop reported it as a changed attribute of every resource that
                // changed for another reason. When neither side carries a value it is
                // not a change.
                //
                // Scoped to this key on purpose. For any other key a null-leaved value
                // can be real: plan JSON writes an unknown list element as null and this
                // package does not read `after_unknown`, so a list of nulls on the
                // `after` side can be values known only after apply; and an object of
                // nulls where the other side is null is an empty block that is present
                // where it was absent. A `timeouts` value with any non-null leaf is still
                // a change.
                if (k === TIMEOUTS_KEY && nullEquivalent(bv) && nullEquivalent(av))
                    continue;
                changedKeys.push(k);
            }
            const sink = { attrs: [], omitted: 0, max: 0, marked };
            for (let i = 0; i < changedKeys.length; i++) {
                const k = changedKeys[i];
                // The row budget is shared by every changed path in the entry, so one
                // key's expansion could take all of it: 50 changed keys in a map that
                // sorts first hid every other attribute's change, where v1.4.2 gave each
                // changed attribute a row. So each key leaves one row for every changed
                // key after it, as long as it keeps one itself; past the cap a key's rows
                // are counted in omitted_attrs, as before.
                const left = maxAttrsPerEntry - sink.attrs.length;
                sink.max = sink.attrs.length + Math.max(Math.min(1, left), left - (changedKeys.length - i - 1));
                // Union, not per-side: terraform applies a config-derived mark (a
                // `sensitive = true` variable, sensitive(), a sensitive module output)
                // to the PLANNED value only — it is never persisted to state — so a
                // credential routinely arrives marked on exactly one side. Masking each
                // side against its own mirror would emit the other side in cleartext
                // (the `~ user_data = "old-plaintext" -> (sensitive value)` shape).
                // Over-masking a symmetric pair costs nothing: both sides already
                // render "(sensitive)". `walkAttr` applies it at every path it emits.
                walkAttr(sink, k, own(bObj, k), own(aObj, k), mirrorFor(bs, k), mirrorFor(as_, k), 0);
            }
            omittedAttrs += sink.omitted;
            if (sink.attrs.length > 0)
                item.attrs = sink.attrs;
        }
        summary.push(item);
    }
    return { added, changed, destroyed, summary, unmasked, omittedEntries, omittedAttrs };
}
function summarize(plan, options = {}) {
    const maxEntries = options.maxEntries ?? exports.DEFAULT_MAX_ENTRIES;
    const maxAttrsPerEntry = options.maxAttrsPerEntry ?? exports.DEFAULT_MAX_ATTRS_PER_ENTRY;
    // The plan is attacker-influenced JSON that has been through JSON.parse, not a
    // typed object: every field is `unknown` at runtime no matter what `Plan`
    // declares. Normalise the fields this function reads ONCE, here, so that
    // every reader below sees the declared type and the two helpers inside
    // `processChanges` cannot disagree about it. Previously `isSkipped` duck-typed
    // `actions` while `has` guarded it, so `{"length":1,"0":"no-op"}` was DROPPED
    // from the summary entirely, and a non-array `resource_changes` threw a raw
    // TypeError out of the library into the consumer's CI step.
    //
    // Whether it IS an array is also the parse signal: a `terraform show -json`
    // document always carries `resource_changes`, so its absence or wrong type
    // means this is not a plan — the one thing summarize() can say truthfully
    // about a document it could not read. See `Result.unparseable`.
    const rawChanges = plan?.resource_changes;
    const unparseable = !Array.isArray(rawChanges);
    const changes = unparseable ? [] : rawChanges;
    const primary = processChanges(changes, maxEntries, maxAttrsPerEntry);
    // `resource_drift` is optional and purely additive, so unlike `resource_changes`
    // above its absence or wrong type is not a parse failure — it is simply "no
    // drift reported", and does not touch `unparseable` (which describes the
    // DOCUMENT, not this one optional field).
    const rawDrift = plan?.resource_drift;
    const driftChanges = Array.isArray(rawDrift) ? rawDrift : [];
    const drift = processChanges(driftChanges, maxEntries, maxAttrsPerEntry);
    return {
        added: primary.added,
        changed: primary.changed,
        destroyed: primary.destroyed,
        drift_added: drift.added,
        drift_changed: drift.changed,
        drift_destroyed: drift.destroyed,
        drifted: primary.added + primary.changed + primary.destroyed > 0,
        summary: primary.summary,
        drift_summary: drift.summary,
        unparseable,
        unmasked: primary.unmasked,
        truncated: primary.omittedEntries > 0 || primary.omittedAttrs > 0,
        omitted_entries: primary.omittedEntries,
        omitted_attrs: primary.omittedAttrs,
    };
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
function moduleCallsPlan(plan) {
    const raw = plan?.configuration?.root_module?.module_calls;
    const calls = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    // Null-prototype: a module named "__proto__" must land as an own property.
    const module_calls = Object.create(null);
    // Code-point order, matching the jq mirror: jq's `keys` sorts by code point,
    // so an above-BMP module name ordered differently here than in the dispatched
    // payload for the identical plan. See compareCodePoints.
    const names = Object.keys(calls).sort(compareCodePoints);
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
