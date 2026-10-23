import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_ATTRS_PER_ENTRY,
  DEFAULT_MAX_ENTRIES,
  MAX_ATTR_PATH_CODE_POINTS,
  MAX_ATTR_PATH_DEPTH,
  moduleCallsPlan,
  summarize,
  type Plan,
  type Result,
  type SummaryEntry,
} from '../src/summarize'

// The conformance runner for the canonical side of the contract.
//
// `conformance/vectors.json` is the shared corpus: one input plan per vector
// plus the EXPECTED output, hand-authored as intent. The Go `driftingest` mirror
// and the jq in the backend's dispatched CI templates run the SAME file from a
// byte-identical vendored copy (terraform-state-manager-backend,
// internal/services/driftingest/testdata/conformance/).
//
// Two anchors make that a real cross-implementation check rather than three
// independent test suites that happen to share a filename:
//
//   1. CORPUS_SHA256 — the digest of the corpus file itself, asserted with the
//      same literal on both sides. Editing one copy without the other reddens
//      that repository immediately, so the two can never silently drift apart.
//   2. RECONCILED_DIGEST — a digest over the RENDERED results of every vector
//      that has no stated per-implementation difference. Both sides render
//      through the same documented discipline (fixed key order, no HTML
//      escaping, U+2028/U+2029 escaped) and assert the same literal, so one
//      differing byte anywhere in the reconciled set reddens both repositories
//      without either needing to see the other's output.
//
// A vector carrying a `go` or `jq` key records a difference that is KNOWN and
// written down; those are excluded from the digest and asserted against their
// own stated expectation on the mirror's side. A difference with no entry in the
// corpus is a regression, which is the whole point.
const corpusURL = new URL('../conformance/vectors.json', import.meta.url)
const corpusBytes = readFileSync(corpusURL)

/** Byte digest of the corpus file. The Go mirror pins this same literal.
 *
 *  Updated for the 6 `drift/*` vectors added alongside `resource_drift` /
 *  `drift_added` / `drift_changed` / `drift_destroyed` / `drift_summary`
 *  (contract Phase 5 item 1): the corpus file's bytes changed, so this digest
 *  must change with it — a stale value here would mean this repo's copy and
 *  the Go mirror's vendored copy have silently diverged.
 *
 *  Updated again for the 7 `timeouts` null-equivalence vectors
 *  (`attrs/timeouts-*`, `attrs/null-leaved-vs-null-on-another-key-still-shows`).
 *
 *  Updated again for per-path attrs and mark-only masking: 15 `attrs/*`, 14
 *  `masking/*` and 2 `drift/*` vectors, the two new `limits`, the changed
 *  expectation of `attrs/timeouts-with-a-value-still-shows` and three
 *  re-worded `masking/*` whys. */
const CORPUS_SHA256 = '4fdc8feaa9f18a28244c4427fd1460bb8019d9f49cb7b65151c85c7c687f650a'

/** Digest over the rendered results of the reconciled subset. Same literal in
 *  the Go mirror.
 *
 *  Updated for the same reason as CORPUS_SHA256: `render()` now includes
 *  `drift_added`/`drift_changed`/`drift_destroyed`/`drift_summary`, so every
 *  reconciled vector's rendered bytes changed even where its drift fields are
 *  all-default, and the 6 new `drift/*` vectors (none states a `go`
 *  difference, so all 6 join the reconciled set) contribute their own rows.
 *
 *  Updated again for the 7 `timeouts` vectors, which state no `go` difference
 *  and so all join the reconciled set.
 *
 *  Updated again for the 31 per-path attrs and masking vectors, none of which
 *  states a `go` difference, and for the one changed timeouts expectation. */
const RECONCILED_DIGEST = 'b794eea7eb3bea9970c4bfddbd12b686c15e9bf4745c297b28d3e81481d8fe28'

/** Digest over the emitted module provenance of every vector that carries an
 *  `expect_module_calls`. The jq mirror in the backend's dispatched templates
 *  pins this same literal — that path has no `attrs` at all, so provenance is
 *  the axis on which it and this package have to agree byte-for-byte. */
const PROVENANCE_DIGEST = '102777523913f3d90fb5a1a0bd7860e9b96c8b42f31ac30ceef13ad6ab1bcc3c'

interface Vector {
  id: string
  why: string
  plan: Plan | null
  /** States only the NON-DEFAULT markers; `render` fills the rest from the zero
   *  value, so a vector says what is interesting about it rather than restating
   *  five zeroes 56 times. */
  expect: Partial<Result>
  expect_module_calls?: unknown
  go?: unknown
  jq?: unknown
}

const corpus = JSON.parse(corpusBytes.toString('utf8')) as {
  limits: { max_entries: number; max_attrs_per_entry: number; max_attr_path_depth: number; max_attr_path_code_points: number }
  vectors: Vector[]
}

/** Renders one `summary`/`drift_summary` array under the shared discipline:
 *  `attrs` omitted, never emitted as null or []. Factored out so the two
 *  parallel arrays go through identical rendering rather than a second copy
 *  of the same mapping. */
function renderEntries(entries: SummaryEntry[]): unknown[] {
  return entries.map((e) =>
    e.attrs === undefined
      ? { address: e.address, actions: e.actions }
      : {
          address: e.address,
          actions: e.actions,
          attrs: e.attrs.map((a) => ({ name: a.name, before: a.before, after: a.after })),
        },
  )
}

/** The rendering discipline the mirrors reproduce, and the reason this is a
 *  function rather than a bare JSON.stringify:
 *    - field order is fixed by construction, not by the corpus file's key order;
 *    - `attrs` is omitted, never emitted as null or [];
 *    - U+2028/U+2029 are escaped, matching Go's encoding/json, which escapes
 *      them unconditionally;
 *    - `<`, `>` and `&` stay raw, so the Go side must render through an encoder
 *      with SetEscapeHTML(false). */
function render(r: Partial<Result>): string {
  const doc = {
    added: r.added ?? 0,
    changed: r.changed ?? 0,
    destroyed: r.destroyed ?? 0,
    drift_added: r.drift_added ?? 0,
    drift_changed: r.drift_changed ?? 0,
    drift_destroyed: r.drift_destroyed ?? 0,
    drifted: r.drifted ?? false,
    unparseable: r.unparseable ?? false,
    unmasked: r.unmasked ?? false,
    truncated: r.truncated ?? false,
    omitted_entries: r.omitted_entries ?? 0,
    omitted_attrs: r.omitted_attrs ?? 0,
    summary: renderEntries(r.summary ?? []),
    drift_summary: renderEntries(r.drift_summary ?? []),
  }
  return escapeSeparators(JSON.stringify(doc))
}

/** Go's encoding/json escapes U+2028/U+2029 unconditionally, so the comparison
 *  envelope has to as well or the two sides differ on the harness rather than on
 *  the contract. `<`, `>` and `&` deliberately stay raw — the Go side renders
 *  through an encoder with SetEscapeHTML(false). */
function escapeSeparators(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

describe('conformance corpus', () => {
  it('is the exact file the mirrors vendor', () => {
    expect(createHash('sha256').update(corpusBytes).digest('hex')).toBe(CORPUS_SHA256)
  })

  it('declares the bounds this implementation enforces', () => {
    // The limits are the contract's, not this file's. If they are changed here
    // without the corpus (or the other way round), the two stop describing the
    // same bound and a consumer cannot tell a capped summary from a complete
    // one across producers.
    expect(corpus.limits.max_entries).toBe(DEFAULT_MAX_ENTRIES)
    expect(corpus.limits.max_attrs_per_entry).toBe(DEFAULT_MAX_ATTRS_PER_ENTRY)
    // Where an attribute stops being expanded into per-path rows. A producer
    // that expanded one level further would emit different rows for the same
    // plan, and a different `omitted_attrs`.
    expect(corpus.limits.max_attr_path_depth).toBe(MAX_ATTR_PATH_DEPTH)
    expect(corpus.limits.max_attr_path_code_points).toBe(MAX_ATTR_PATH_CODE_POINTS)
  })

  it('has vectors, uniquely identified', () => {
    // An empty or deduplicated corpus is a discovery failure, not a pass: every
    // assertion below is a loop over this array.
    expect(corpus.vectors.length).toBeGreaterThan(40)
    expect(new Set(corpus.vectors.map((v) => v.id)).size).toBe(corpus.vectors.length)
  })

  it.each(corpus.vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    expect(render(summarize(vector.plan))).toBe(render(vector.expect))
  })

  // `resource_drift`/`drift_added`/`drift_changed`/`drift_destroyed`/`drift_summary`
  // are additive: every vector that predates them (id NOT prefixed `drift/`) must
  // keep reporting byte-identical `summary` and the three original counts, which is
  // the back-compat guarantee the whole design rests on. Pinned so a future edit
  // to what counts as "pre-existing" is deliberate, not an accidental narrowing
  // or widening of this guard's coverage: 56 when resource_drift landed, 63 since
  // the 7 `timeouts` null-equivalence vectors, 92 since the 15 per-path attrs
  // and 14 mark-only masking vectors.
  it('summary and the three existing counts are unchanged for every pre-existing vector', () => {
    const preExisting = corpus.vectors.filter((v) => !v.id.startsWith('drift/'))
    expect(preExisting.length).toBe(92)
    for (const vector of preExisting) {
      const result = summarize(vector.plan)
      expect(result.added).toBe(vector.expect.added ?? 0)
      expect(result.changed).toBe(vector.expect.changed ?? 0)
      expect(result.destroyed).toBe(vector.expect.destroyed ?? 0)
      expect(JSON.stringify(result.summary)).toBe(JSON.stringify(vector.expect.summary ?? []))
    }
  })

  const provenance = corpus.vectors.filter((v) => v.expect_module_calls !== undefined)
  it.each(provenance.map((v) => [v.id, v] as const))('%s — module provenance', (_id, vector) => {
    // Serialised, not deep-equal: `module_calls` KEY ORDER is part of what the
    // jq mirror has to reproduce, and one of these vectors exists only to pin
    // it. A toEqual() here was written first and mutation testing proved it
    // inert — reverting the code-point sort left it green.
    expect(escapeSeparators(JSON.stringify(moduleCallsPlan(vector.plan)))).toBe(
      escapeSeparators(JSON.stringify(vector.expect_module_calls)),
    )
  })

  it('agrees with the jq mirror byte-for-byte across the provenance vectors', () => {
    expect(provenance.length).toBeGreaterThan(2)
    const h = createHash('sha256')
    for (const vector of provenance) {
      h.update(`${vector.id}\n${escapeSeparators(JSON.stringify(moduleCallsPlan(vector.plan)))}\n`)
    }
    expect(h.digest('hex')).toBe(PROVENANCE_DIGEST)
  })

  it('agrees with the mirrors byte-for-byte across the reconciled subset', () => {
    const reconciled = corpus.vectors.filter((v) => v.go === undefined)
    expect(reconciled.length).toBeGreaterThan(40)
    const h = createHash('sha256')
    for (const vector of reconciled) h.update(`${vector.id}\n${render(summarize(vector.plan))}\n`)
    expect(h.digest('hex')).toBe(RECONCILED_DIGEST)
  })
})
