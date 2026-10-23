import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fmt } from '../src/index'
import { sameCanon } from '../src/summarize'

// `sameCanon` decides `stableStringify(x) === stableStringify(y)` without
// building either string. A second notion of equality beside the serializer is
// exactly how a change gets reported in a form the comparison never saw, so this
// holds the two to the same answer on every pair it can construct.
//
// The reference is `fmt([x])`: for a value whose serialisation stays under the
// 300-code-point cap that is `"[" + stableStringify(x) + "]"`, and wrapping in an
// array keeps the string "1" apart from the number 1 (fmt passes a bare string
// through raw). Every value here is small, and the test asserts nothing was cut.
function reference(x: unknown, y: unknown): boolean {
  const a = fmt([x]) as string
  const b = fmt([y]) as string
  if (a.endsWith('…') || b.endsWith('…')) throw new Error('fixture past the value cap')
  return a === b
}

// Own data properties only, as JSON.parse makes them — including `__proto__`.
function obj(entries: Array<[string, unknown]>): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
  return o
}

const LEAVES: unknown[] = [
  null, undefined, 0, -0, 1, 1.5, 1e21, 2 ** 53, 2 ** 53 + 1, -1, Infinity, -Infinity, NaN,
  '', '0', '1', '-0', 'null', 'true', 'a', ' ', '\ud800', '\u{1F600}', true, false,
]
const KEYS = ['a', 'b', '__proto__', 'constructor', '0', '', '\u{1F600}']

// A small deterministic PRNG, so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function gen(r: () => number, depth: number): unknown {
  const p = r()
  if (depth <= 0 || p < 0.45) return LEAVES[Math.floor(r() * LEAVES.length)]
  if (p < 0.7) return Array.from({ length: Math.floor(r() * 3) }, () => gen(r, depth - 1))
  const n = Math.floor(r() * 3)
  const entries: Array<[string, unknown]> = []
  for (let i = 0; i < n; i++) {
    const k = KEYS[Math.floor(r() * KEYS.length)]
    if (!entries.some(([e]) => e === k)) entries.push([k, gen(r, depth - 1)])
  }
  return obj(entries)
}

// A copy with object keys in another order: equal by definition.
function reorder(v: unknown, r: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => reorder(x, r))
  if (v !== null && typeof v === 'object') {
    const entries = Object.keys(v).map((k) => [k, reorder((v as Record<string, unknown>)[k], r)] as [string, unknown])
    entries.sort(() => r() - 0.5)
    return obj(entries)
  }
  return v
}

// A copy with one leaf replaced: equal or not, depending on the leaf.
function mutate(v: unknown, r: () => number): unknown {
  if (r() < 0.3 || v === null || typeof v !== 'object') return LEAVES[Math.floor(r() * LEAVES.length)]
  if (Array.isArray(v)) {
    if (v.length === 0) return [LEAVES[Math.floor(r() * LEAVES.length)]]
    const i = Math.floor(r() * v.length)
    return v.map((x, j) => (j === i ? mutate(x, r) : x))
  }
  const keys = Object.keys(v)
  if (keys.length === 0) return obj([['a', null]])
  const k = keys[Math.floor(r() * keys.length)]
  return obj(keys.map((key) => [key, key === k ? mutate((v as Record<string, unknown>)[key], r) : (v as Record<string, unknown>)[key]]))
}

describe('sameCanon is the canonical string comparison', () => {
  it.each([
    ['null and absent', null, undefined, true],
    ['null and Infinity (both serialise as null)', null, Infinity, true],
    ['Infinity and -Infinity', Infinity, -Infinity, true],
    ['0 and -0', 0, -0, false],
    ['-0 and -0', -0, -0, true],
    ['1 and 1.0', 1, 1.0, true],
    ['2^53 and 2^53 + 1 (one double)', 2 ** 53, 2 ** 53 + 1, true],
    ['the string "1" and the number 1', '1', 1, false],
    ['the string "null" and null', 'null', null, false],
    ['[] and {}', [], {}, false],
    ['a null member and an absent one', { a: 1, x: null }, { a: 1 }, false],
    ['key order', obj([['a', 1], ['b', 2]]), obj([['b', 2], ['a', 1]]), true],
    ['an own __proto__ key', obj([['__proto__', 1]]), {}, false],
  ])('%s', (_label, x, y, want) => {
    expect(reference(x, y)).toBe(want)
    expect(sameCanon(x, y)).toBe(want)
  })

  it('agrees on 20,000 generated pairs', () => {
    const r = rng(20261023)
    let equal = 0
    for (let i = 0; i < 20000; i++) {
      const x = gen(r, 4)
      const y = r() < 0.5 ? reorder(x, r) : mutate(x, r)
      const want = reference(x, y)
      if (want) equal++
      if (sameCanon(x, y) !== want) throw new Error(`disagree on ${JSON.stringify([fmt([x]), fmt([y])])}`)
    }
    // Both outcomes are exercised in quantity, or the agreement says little.
    expect(equal).toBeGreaterThan(5000)
    expect(equal).toBeLessThan(15000)
  })

  it('agrees on every pair of attribute values in the conformance corpus', () => {
    const corpus = JSON.parse(readFileSync(new URL('../conformance/vectors.json', import.meta.url), 'utf8')) as {
      vectors: Array<{ plan: { resource_changes?: unknown; resource_drift?: unknown } | null }>
    }
    const values: unknown[] = []
    for (const v of corpus.vectors) {
      for (const list of [v.plan?.resource_changes, v.plan?.resource_drift]) {
        if (!Array.isArray(list)) continue
        for (const rc of list) {
          const ch = (rc as { change?: Record<string, unknown> } | null)?.change
          for (const side of [ch?.before, ch?.after]) {
            if (side !== null && typeof side === 'object' && !Array.isArray(side)) values.push(...Object.values(side))
          }
        }
      }
    }
    const small = values.filter((v) => !(fmt([v]) as string).endsWith('…'))
    expect(small.length).toBeGreaterThan(200)
    for (const x of small) for (const y of small) if (sameCanon(x, y) !== reference(x, y)) throw new Error(`disagree on ${fmt([x])} / ${fmt([y])}`)
  })
})
