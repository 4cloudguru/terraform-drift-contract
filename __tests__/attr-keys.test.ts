import { describe, expect, it } from 'vitest'
import { fmt, summarize, type AttrChange, type Plan } from '../src/index'

// The attrs loop iterates the UNION of before/after keys, so one side is
// routinely missing the key it is asked for. Every fixture in the suite had
// identical key sets on both sides, so the asymmetric path — the one where a
// prototype-chain read differs from an own-property read — was never exercised.

function update(before: unknown, after: unknown): Plan {
  return { resource_changes: [{ address: 'aws_instance.x', change: { actions: ['update'], before, after } }] }
}

function attrs(plan: Plan): AttrChange[] {
  return summarize(plan).summary[0]?.attrs ?? []
}

describe('attrs: asymmetric key sets', () => {
  it('a key present only in before reports after: null (a removed attribute)', () => {
    expect(attrs(update({ a: 1, gone: 'x' }, { a: 2 }))).toEqual([
      { name: 'a', before: '1', after: '2' },
      { name: 'gone', before: 'x', after: null },
    ])
  })

  it('a key present only in after reports before: null (a new attribute)', () => {
    expect(attrs(update({ a: 1 }, { a: 2, added: 'y' }))).toEqual([
      { name: 'a', before: '1', after: '2' },
      { name: 'added', before: null, after: 'y' },
    ])
  })

  it('an explicit null and an absent key are the same value, so no attr is emitted', () => {
    expect(attrs(update({ a: 1, maybe: null }, { a: 1 }))).toEqual([])
  })
})

describe('attrs: attacker-shaped key names', () => {
  // `__proto__` is an OWN data property when it arrives through JSON.parse, so
  // it reaches this loop. A bare `aObj['__proto__']` returned Object.prototype,
  // which serialises as `{}`: a removed __proto__ attribute compared equal to an
  // empty object and vanished from attrs, and a present one reported `"{}"`
  // where the truthful answer is null.
  // Built from raw JSON TEXT on purpose: in an object literal `__proto__:` sets
  // the prototype and is not an own property at all, so a fixture written as a
  // literal cannot reach this path. JSON.parse defines it as own data.
  const parsePlan = (before: string, after: string): Plan =>
    JSON.parse(
      `{"resource_changes":[{"address":"aws_instance.x","change":{"actions":["update"],"before":${before},"after":${after}}}]}`,
    ) as Plan

  it('a __proto__ key present on one side only is reported, not swallowed', () => {
    const plan = parsePlan('{"__proto__":{"secret":"S3CRET"}}', '{}')
    expect(Object.prototype.hasOwnProperty.call(plan.resource_changes![0].change!.before, '__proto__')).toBe(true)
    expect(attrs(plan)).toEqual([{ name: '__proto__', before: '{"secret":"S3CRET"}', after: null }])
  })

  it('a __proto__ key equal on both sides emits nothing', () => {
    expect(attrs(parsePlan('{"__proto__":{}}', '{"__proto__":{}}'))).toEqual([])
  })

  it.each(['constructor', 'prototype', 'toString', 'valueOf'])(
    'a %s-named attribute is treated as ordinary data',
    (key) => {
      const plan = JSON.parse(
        JSON.stringify({
          resource_changes: [
            { address: 'aws_instance.x', change: { actions: ['update'], before: { [key]: 'old' }, after: { [key]: 'new' } } },
          ],
        }),
      ) as Plan
      expect(attrs(plan)).toEqual([{ name: key, before: 'old', after: 'new' }])
    },
  )

  it('summarize returns a plain result with no inherited surprises', () => {
    summarize(parsePlan('{"__proto__":{"polluted":true}}', '{}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('fmt: the truncation boundary is well-formed for non-BMP input', () => {
  // The boundary itself is already table-driven over astral input in
  // untrusted-plan-input.test.ts. What no row asserted is that the string
  // handed to a consumer is still valid UTF-16 — a slice that lands between the
  // two units of a surrogate pair produces a lone surrogate, which serialises
  // into a callback body as U+FFFD or throws in a stricter encoder.
  const EMOJI = '\u{1F600}' // one code point, two UTF-16 units

  it.each([300, 301, 500, 5000])('%i astral code points truncate to a well-formed string', (count) => {
    const out = fmt(EMOJI.repeat(count)) as string
    expect(() => encodeURIComponent(out)).not.toThrow()
    expect(out).toBe(count <= 300 ? EMOJI.repeat(count) : EMOJI.repeat(300) + '…')
  })

  it('an astral code point straddling the boundary is dropped whole, not halved', () => {
    const out = fmt('x'.repeat(299) + EMOJI + EMOJI) as string
    expect(Array.from(out).length).toBe(301) // 300 code points plus U+2026
    expect(() => encodeURIComponent(out)).not.toThrow()
  })
})
