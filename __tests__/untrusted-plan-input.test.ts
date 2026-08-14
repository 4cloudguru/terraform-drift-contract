import { describe, it, expect } from 'vitest'
import { summarize, fmt, Plan } from '../src/summarize'

// ---------------------------------------------------------------------------
// Defect class 1: "the code trusts the DECLARED TypeScript type of a field that
// is attacker-influenced JSON at runtime."
//
// `Plan` is a compile-time description of a document that arrived through
// JSON.parse. Every field in it is `unknown` at runtime. The class had four
// instances, all on the same loop, and they failed in three different
// directions — which is the tell that this was an oversight rather than a
// contract:
//
//   - `resource_changes` not an array  -> raw TypeError out of the library
//     (#23), except a STRING, which iterated per character and emitted bogus
//     entries;
//   - a null/primitive ELEMENT          -> raw TypeError on `c.change` (#23);
//   - `actions` not an array            -> isSkipped() duck-typed it where
//     has() refused it, so a fake `{length:1,"0":"no-op"}` was DROPPED from the
//     summary entirely — drift concealment (#13);
//   - `address` not a string            -> an object landed in a field
//     `SummaryEntry` declares `string` (#15).
//
// One normalisation at the loop head closes all four. Every row below fails if
// it is removed.
// ---------------------------------------------------------------------------

/** The output projection these rows assert over. */
const shape = (p: unknown) => {
  const r = summarize(p as Plan)
  return {
    counts: [r.added, r.changed, r.destroyed],
    drifted: r.drifted,
    summary: r.summary.map((e) => ({ address: e.address, actions: e.actions })),
  }
}

const CLEAN = { counts: [0, 0, 0], drifted: false, summary: [] }

const update = (change: unknown) => ({ resource_changes: [{ address: 'aws_instance.x', change }] })

interface ShapeRow {
  name: string
  plan: unknown
  want: unknown
}

const shapeRows: ShapeRow[] = [
  // --- resource_changes is not an array (#23) -------------------------------
  { name: 'resource_changes: false → no throw, empty summary', plan: { resource_changes: false }, want: CLEAN },
  { name: 'resource_changes: {} → no throw, empty summary', plan: { resource_changes: {} }, want: CLEAN },
  { name: 'resource_changes: 42 → no throw, empty summary', plan: { resource_changes: 42 }, want: CLEAN },
  {
    // The nastiest of the set: a string IS iterable, so this did not throw — it
    // silently emitted one bogus entry per character.
    name: 'resource_changes: "abc" → NOT iterated per character',
    plan: { resource_changes: 'abc' },
    want: CLEAN,
  },
  { name: 'resource_changes: null → empty summary', plan: { resource_changes: null }, want: CLEAN },

  // --- a single malformed ELEMENT must not abort the whole plan (#23) -------
  { name: 'element null → skipped, no throw', plan: { resource_changes: [null] }, want: CLEAN },
  { name: 'element 42 → skipped, no throw', plan: { resource_changes: [42] }, want: CLEAN },
  { name: 'element "x" → skipped, no throw', plan: { resource_changes: ['x'] }, want: CLEAN },
  { name: 'element [] → skipped, no throw', plan: { resource_changes: [[]] }, want: CLEAN },
  {
    name: 'a bad element does not abort the good ones that follow it',
    plan: {
      resource_changes: [
        null,
        { address: 'aws_instance.good', change: { actions: ['create'] } },
        42,
        { address: 'aws_instance.also_good', change: { actions: ['delete'] } },
      ],
    },
    want: {
      counts: [1, 0, 1],
      drifted: true,
      summary: [
        { address: 'aws_instance.good', actions: ['create'] },
        { address: 'aws_instance.also_good', actions: ['delete'] },
      ],
    },
  },

  // --- `actions` duck-typing (#13) ------------------------------------------
  {
    // The drift-concealment primitive: this shape satisfied
    // `actions.length === 1 && actions[0] === 'no-op'`, so the resource change
    // vanished from the summary. It must now be PRESENT and uncounted.
    name: 'actions {length:1,"0":"no-op"} → entry PRESENT and uncounted, not dropped',
    plan: update({ actions: { length: 1, 0: 'no-op' } }),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'actions {length:1,"0":"read"} → entry PRESENT and uncounted, not dropped',
    plan: update({ actions: { length: 1, 0: 'read' } }),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'actions "update" (a raw string) → normalised to [], never emitted as a string',
    plan: update({ actions: 'update' }),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'actions 5 → normalised to []',
    plan: update({ actions: 5 }),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'actions null → normalised to []',
    plan: update({ actions: null }),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'actions with non-string members → only the strings survive, counts follow them',
    plan: update({ actions: ['update', 5, null, { a: 1 }] }),
    want: { counts: [0, 1, 0], drifted: true, summary: [{ address: 'aws_instance.x', actions: ['update'] }] },
  },
  {
    // A genuinely-skipped list still skips: normalising must not defeat the
    // skip rule, which is part of the reconciled contract.
    name: 'actions ["no-op"] (genuine) → still skipped',
    plan: update({ actions: ['no-op'] }),
    want: CLEAN,
  },
  {
    name: 'actions ["read"] (genuine) → still skipped',
    plan: update({ actions: ['read'] }),
    want: CLEAN,
  },
  {
    name: 'actions ["delete","create"] → replace-aware counts unchanged',
    plan: update({ actions: ['delete', 'create'] }),
    want: {
      counts: [1, 0, 1],
      drifted: true,
      summary: [{ address: 'aws_instance.x', actions: ['delete', 'create'] }],
    },
  },

  // --- `change` itself malformed --------------------------------------------
  {
    name: 'change: null → entry present, uncounted',
    plan: update(null),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },
  {
    name: 'change: "x" → entry present, uncounted',
    plan: update('x'),
    want: { counts: [0, 0, 0], drifted: false, summary: [{ address: 'aws_instance.x', actions: [] }] },
  },

  // --- `address` type confusion (#15) ---------------------------------------
  {
    name: 'address {not:"a string"} → emitted as "", never as an object',
    plan: { resource_changes: [{ address: { not: 'a string' }, change: { actions: ['create'] } }] },
    want: { counts: [1, 0, 0], drifted: true, summary: [{ address: '', actions: ['create'] }] },
  },
  {
    name: 'address 12345 → emitted as ""',
    plan: { resource_changes: [{ address: 12345, change: { actions: ['create'] } }] },
    want: { counts: [1, 0, 0], drifted: true, summary: [{ address: '', actions: ['create'] }] },
  },
  {
    name: 'address absent → ""',
    plan: { resource_changes: [{ change: { actions: ['create'] } }] },
    want: { counts: [1, 0, 0], drifted: true, summary: [{ address: '', actions: ['create'] }] },
  },
]

describe('defect class: untrusted plan input must not be trusted to match its declared type', () => {
  it.each(shapeRows)('$name', ({ plan, want }) => {
    expect(shape(plan)).toEqual(want)
  })

  it('no shape in the table throws out of the library', () => {
    for (const row of shapeRows) {
      expect(() => summarize(row.plan as Plan), row.name).not.toThrow()
    }
  })

  it('every emitted entry honours the declared SummaryEntry types', () => {
    for (const row of shapeRows) {
      for (const e of summarize(row.plan as Plan).summary) {
        expect(typeof e.address, row.name).toBe('string')
        expect(Array.isArray(e.actions), row.name).toBe(true)
        for (const a of e.actions) expect(typeof a, row.name).toBe('string')
      }
    }
  })

  it('address is type-checked but deliberately NOT truncated (it is the record key)', () => {
    const long = 'aws_instance.x["' + 'k'.repeat(5000) + '"]'
    const r = summarize({ resource_changes: [{ address: long, change: { actions: ['create'] } }] })
    expect(r.summary[0].address).toBe(long)
  })
})

// ---------------------------------------------------------------------------
// Defect class 2: "an absent key and an explicit null are treated as different,
// so a change that is not a change is emitted." (#19)
//
// stableStringify() returned the VALUE undefined for undefined input — its
// `: string` signature was a runtime lie — and jsonEqual then compared
// `undefined === 'null'` and said "different". Terraform produces this shape
// routinely: an attribute whose post-apply value is unknown is OMITTED from
// `after` and reported in `after_unknown` instead.
//
// The Go mirror's canon() maps both an absent key and an explicit null to
// "null", so this fix CLOSES a divergence rather than opening one.
// ---------------------------------------------------------------------------

const attrsOf = (change: Record<string, unknown>) =>
  summarize({ resource_changes: [{ address: 'aws_instance.x', change: { actions: ['update'], ...change } }] })
    .summary[0].attrs

const nullRows = [
  {
    name: 'before has an explicit null, after omits the key → NOT a change',
    got: () => attrsOf({ before: { desc: null, size: 1 }, after: { size: 2 } }),
    want: [{ name: 'size', before: '1', after: '2' }],
  },
  {
    name: 'after has an explicit null, before omits the key → NOT a change',
    got: () => attrsOf({ before: { size: 1 }, after: { desc: null, size: 2 } }),
    want: [{ name: 'size', before: '1', after: '2' }],
  },
  {
    name: 'the phantom is the ONLY differing key → no attrs field at all',
    got: () => attrsOf({ before: { desc: null }, after: {} }),
    want: undefined,
  },
  {
    name: 'explicit null on both sides → NOT a change',
    got: () => attrsOf({ before: { desc: null }, after: { desc: null } }),
    want: undefined,
  },
  {
    name: 'key absent on both sides → NOT a change',
    got: () => attrsOf({ before: {}, after: {} }),
    want: undefined,
  },
  {
    // The other direction must still register: null -> a real value IS a change.
    name: 'null → a real value is still reported',
    got: () => attrsOf({ before: { desc: null }, after: { desc: 'now-set' } }),
    want: [{ name: 'desc', before: null, after: 'now-set' }],
  },
  {
    name: 'a real value → null is still reported',
    got: () => attrsOf({ before: { desc: 'was-set' }, after: { desc: null } }),
    want: [{ name: 'desc', before: 'was-set', after: null }],
  },
  {
    name: 'a real value → absent is still reported',
    got: () => attrsOf({ before: { desc: 'was-set' }, after: {} }),
    want: [{ name: 'desc', before: 'was-set', after: null }],
  },
]

describe('defect class: absent and explicit null are the same value (matches the Go mirror)', () => {
  it.each(nullRows)('$name', ({ got, want }) => {
    expect(got()).toEqual(want)
  })
})

// ---------------------------------------------------------------------------
// Defect class 3: "work proportional to the whole attacker-supplied value is
// done before the bound that discards it." (#12)
//
// fmt() called Array.from(s) on the ENTIRE value — one JS string per code point
// — and only then kept 300 of them, ~22x the input in peak heap (1.4 GiB for a
// single 64 MiB attribute). The fix is observationally identical BY DESIGN, so
// the rows below are of two kinds and both are needed:
//   - equivalence rows, which redden if the fast path's bound is wrong (they
//     compare against the pre-fix algorithm on the tricky inputs);
//   - one resource row, which is the only thing that reddens if the fast path
//     is deleted outright.
// ---------------------------------------------------------------------------

/** The pre-fix algorithm, verbatim, as the equivalence oracle. */
const referenceFmt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const cps = Array.from(s)
  return cps.length <= 300 ? s : cps.slice(0, 300).join('') + '…'
}

const ASTRAL = '😀' // one code point, TWO UTF-16 units

const equivalenceInputs: { name: string; value: string }[] = [
  { name: 'empty', value: '' },
  { name: '299 ASCII', value: 'x'.repeat(299) },
  { name: 'exactly 300 ASCII (boundary)', value: 'x'.repeat(300) },
  { name: '301 ASCII (boundary+1)', value: 'x'.repeat(301) },
  // 350 code points in 350 UTF-16 units: reddens a fast path bounded too high.
  { name: '350 ASCII', value: 'x'.repeat(350) },
  { name: '5000 ASCII', value: 'x'.repeat(5000) },
  // 200 astral code points = 400 UTF-16 units: length > 300 but code points
  // <= 300, so it must come back WHOLE. Reddens a fast path that confuses the
  // two units.
  { name: '200 astral (400 UTF-16 units, must not truncate)', value: ASTRAL.repeat(200) },
  { name: 'exactly 300 astral (600 UTF-16 units, boundary)', value: ASTRAL.repeat(300) },
  { name: '301 astral (boundary+1, must truncate)', value: ASTRAL.repeat(301) },
  { name: '5000 astral (past the 1200-unit slice)', value: ASTRAL.repeat(5000) },
  { name: 'astral straddling the 1200-unit slice boundary', value: 'x'.repeat(1199) + ASTRAL.repeat(50) },
  { name: 'astral straddling the 300-code-point boundary', value: 'x'.repeat(299) + ASTRAL.repeat(50) },
  { name: 'combining marks', value: 'é́'.repeat(400) },
]

describe('defect class: bounded work on unbounded input (fmt)', () => {
  it.each(equivalenceInputs)('fmt is byte-identical to the pre-fix algorithm: $name', ({ value }) => {
    expect(fmt(value)).toBe(referenceFmt(value))
  })

  it('truncation still emits exactly 300 code points plus the U+2026 marker', () => {
    for (const { name, value } of equivalenceInputs) {
      const out = fmt(value)!
      const cps = Array.from(out)
      if (Array.from(value).length > 300) {
        expect(cps.length, name).toBe(301)
        expect(out.endsWith('…'), name).toBe(true)
      }
    }
  })

  it('non-string values are unaffected by the fast path', () => {
    expect(fmt({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(fmt(null)).toBeNull()
    expect(fmt(undefined)).toBeNull()
    expect(fmt(42)).toBe('42')
  })

  it('one huge value does no work proportional to its length (catches an unbounded Array.from)', () => {
    // 32 MiB: ~24ms bounded, ~332ms unbounded, measured locally. The threshold is
    // ~13x the fixed cost so a slow runner cannot flake it, while still
    // separating cleanly from the unbounded path.
    const huge = 'x'.repeat(32 * 1024 * 1024)
    const started = Date.now()
    const out = fmt(huge)!
    const elapsed = Date.now() - started
    expect(Array.from(out).length).toBe(301)
    expect(elapsed).toBeLessThan(400)
  })

  it('many small values allocate no per-code-point array (catches a deleted <=300 fast path)', () => {
    // The common case: every attribute of every resource is short. Without the
    // `s.length <= 300` early return each call still builds a code-point array,
    // which measured 681ms against 7ms for 600k calls locally — a ~100x gap, so
    // the threshold below cannot flake either way.
    const values = Array.from({ length: 200 }, (_, i) => 'x'.repeat(20 + (i % 280)))
    const started = Date.now()
    for (let n = 0; n < 3000; n++) for (const v of values) fmt(v)
    expect(Date.now() - started).toBeLessThan(300)
  })
})

// ---------------------------------------------------------------------------
// Defect class 4: "one attacker-authored input makes the library produce no
// answer, or an unboundedly large one."
//
// Both are detection failures rather than crashes-as-such. The recursion case
// killed the step BEFORE the drift callback fired, so a single deeply nested
// attribute value in a fork-PR config suppressed drift reporting for the entire
// run. The unbounded case is the other end of the same axis: the returned object
// is POSTed to a callback, written to a file on the runner and stored as a drift
// record, so "no cap anywhere" is an unbounded request body and an unbounded row.
//
// Neither is expressible as a shared conformance vector — a 200,000-deep value
// exceeds encoding/json's own nesting cap in the Go mirror, and a 501-entry plan
// would be 150 KB of committed noise — so they live here, with the LIMITS
// themselves declared in the corpus and asserted there.
// ---------------------------------------------------------------------------
describe('bounded output and unbounded input', () => {
  const nestObj = (n: number) => {
    let v: unknown = 1
    for (let i = 0; i < n; i++) v = { a: v }
    return v
  }
  const nestArr = (n: number) => {
    let v: unknown = 1
    for (let i = 0; i < n; i++) v = [v]
    return v
  }

  it.each([
    ['object', nestObj],
    ['array', nestArr],
  ])('serialises %s nesting far past the old RangeError without throwing', (_kind, nest) => {
    // The recursive serializer threw at ~2,600 (objects) and ~3,124 (arrays);
    // JSON.parse accepts ~300x deeper, so there was a wide band in which a
    // consumer parsed the plan and then this library exploded. 200,000 is two
    // orders of magnitude past both former limits.
    for (const depth of [3000, 200_000]) {
      const r = summarize({
        resource_changes: [
          { address: 'terraform_data.x', change: { actions: ['update'], before: { k: nest(depth) }, after: { k: 2 } } },
        ],
      } as Plan)
      // Not merely "did not throw": the attribute is still reported, truncated
      // to the same 301 code points any other oversized value gets.
      expect(Array.from(r.summary[0].attrs![0].before!).length).toBe(301)
    }
  })

  it('caps summary entries, keeps the COUNTS whole, and says how many it dropped', () => {
    const plan = {
      resource_changes: Array.from({ length: 503 }, (_, i) => ({
        address: `aws_instance.a${i}`,
        change: { actions: ['create'] },
      })),
    } as Plan
    const r = summarize(plan)
    expect(r.summary.length).toBe(500)
    expect(r.omitted_entries).toBe(3)
    expect(r.truncated).toBe(true)
    // The counts are the security signal; capping them would turn a size limit
    // into a missed detection.
    expect(r.added).toBe(503)
    expect(r.drifted).toBe(true)
  })

  it('caps attrs per entry and says how many it dropped, across entries', () => {
    const wide = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(3, '0')}`, i]))
    const bumped = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(3, '0')}`, i + 1]))
    const plan = {
      resource_changes: [
        { address: 'aws_instance.a', change: { actions: ['update'], before: wide(60), after: bumped(60) } },
        { address: 'aws_instance.b', change: { actions: ['update'], before: wide(55), after: bumped(55) } },
      ],
    } as Plan
    const r = summarize(plan)
    expect(r.summary[0].attrs!.length).toBe(50)
    expect(r.summary[1].attrs!.length).toBe(50)
    expect(r.omitted_attrs).toBe(15) // 10 + 5
    expect(r.truncated).toBe(true)
  })

  it('honours caller-supplied limits, and reports nothing omitted when nothing is', () => {
    const plan = {
      resource_changes: [
        { address: 'a.b', change: { actions: ['update'], before: { x: 1, y: 1 }, after: { x: 2, y: 2 } } },
        { address: 'c.d', change: { actions: ['create'] } },
      ],
    } as Plan
    const tight = summarize(plan, { maxEntries: 1, maxAttrsPerEntry: 1 })
    expect(tight.summary.length).toBe(1)
    expect(tight.summary[0].attrs!.length).toBe(1)
    expect(tight.omitted_entries).toBe(1)
    expect(tight.omitted_attrs).toBe(1)
    expect(tight.truncated).toBe(true)
    // …and the same plan under the defaults trips nothing, so `truncated` is
    // never merely decorative.
    const loose = summarize(plan)
    expect(loose.truncated).toBe(false)
    expect(loose.omitted_entries).toBe(0)
    expect(loose.omitted_attrs).toBe(0)
  })

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a non-object', 'not a plan'],
    ['resource_changes: null', { resource_changes: null }],
    ['resource_changes: a string', { resource_changes: 'oops' }],
  ])('reports %s as unparseable rather than as a clean plan', (_name, input) => {
    const r = summarize(input as Plan)
    expect(r.unparseable).toBe(true)
    expect(r.drifted).toBe(false)
  })

  it('a genuinely clean plan is NOT unparseable — the two are distinguishable', () => {
    const r = summarize({ resource_changes: [] } as Plan)
    expect(r.unparseable).toBe(false)
    expect(r.drifted).toBe(false)
  })

  it('flags a change that emits values with no sensitivity metadata, and only that', () => {
    const change = (extra: object) => ({
      resource_changes: [
        { address: 'a.b', change: { actions: ['update'], before: { pw: 'OLD' }, after: { pw: 'NEW' }, ...extra } },
      ],
    }) as Plan
    // No mirrors at all: nothing was masked and nothing could have been.
    expect(summarize(change({})).unmasked).toBe(true)
    // A present-but-false mirror IS metadata: it says "not sensitive".
    expect(summarize(change({ before_sensitive: false, after_sensitive: false })).unmasked).toBe(false)
    expect(summarize(change({ before_sensitive: {}, after_sensitive: {} })).unmasked).toBe(false)
    expect(summarize(change({ after_sensitive: { pw: true } })).unmasked).toBe(false)
    // A skipped change emits no values, so it cannot emit them unmasked.
    expect(
      summarize({
        resource_changes: [{ address: 'a.b', change: { actions: ['no-op'], before: { pw: 'OLD' }, after: { pw: 'OLD' } } }],
      } as Plan).unmasked,
    ).toBe(false)
    // Neither can a create: before is null, so no attrs path is entered.
    expect(
      summarize({
        resource_changes: [{ address: 'a.b', change: { actions: ['create'], before: null, after: { pw: 'NEW' } } }],
      } as Plan).unmasked,
    ).toBe(false)
  })
})
