import { describe, expect, it } from 'vitest'
import { fmt, summarize, type AttrChange, type Plan } from '../src/index'
import { MAX_ATTR_PATH_CODE_POINTS, MAX_ATTR_PATH_DEPTH } from '../src/summarize'

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

describe('attrs: a changed object or array is expanded into per-path rows', () => {
  const change = (before: unknown, after: unknown, extra: Record<string, unknown> = {}): Plan => ({
    resource_changes: [
      {
        address: 'azurerm_resource_group.rg',
        change: { actions: ['update'], before, after, before_sensitive: {}, after_sensitive: {}, ...extra },
      },
    ],
  })
  const rows = (before: unknown, after: unknown, extra?: Record<string, unknown>) => attrs(change(before, after, extra))

  // TBD3216/APP2934, ADO build 378948: a central re-tag changed one of 14 tags.
  // The whole map was over 300 code points, so both sides were cut mid-JSON and
  // the changed key was in neither prefix.
  it('a re-tag reports the changed key, not two truncated maps', () => {
    const tags = {
      ACCESSIBILITY: 'Not Internet Accessible',
      AGN: '',
      APPID: 'APP2934',
      AUDIT: 'None',
      CONFIDENTIALITY: 'Internal',
      COST_CENTER: '101.010.6431.7608003',
      CRITICALITY: 'Supporting',
      DIVISION: 'MER',
      DYNAMIC_FIREWALL: 'SN-MER-APP2934-P-CUS01',
      EXPIRATION_DATE: 'none',
      PROJECT_COST_CENTER: '',
      REQUESTOR: 'Requestor Name',
      SUPPORT_GROUP: 'Cloud Engineering',
      TIER: 'Production',
    }
    expect(fmt(tags)!.endsWith('…')).toBe(true)
    expect(rows({ tags }, { tags: { ...tags, COST_CENTER: '101.010.6405.7694000' } })).toEqual([
      { name: 'tags.COST_CENTER', before: '101.010.6431.7608003', after: '101.010.6405.7694000' },
    ])
  })

  it('an added and a removed key report the missing side as null', () => {
    expect(rows({ tags: { a: '1', gone: 'x' } }, { tags: { a: '1', added: 'y' } })).toEqual([
      { name: 'tags.added', before: null, after: 'y' },
      { name: 'tags.gone', before: 'x', after: null },
    ])
  })

  it('names a non-identifier key as a quoted index, so the path parses back', () => {
    const keys = ['kubernetes.io/role', 'cost-center', '1st', '', 'say "hi"', 'é', 'ok_1', 'a b']
    const side = (v: string) => Object.fromEntries(keys.map((k) => [k, v]))
    expect(rows({ tags: side('a') }, { tags: side('b') }).map((r) => r.name)).toEqual([
      'tags[""]',
      'tags["1st"]',
      'tags["a\\u2028b"]',
      'tags["cost-center"]',
      'tags["kubernetes.io/role"]',
      'tags.ok_1',
      'tags["say \\"hi\\""]',
      'tags["é"]',
    ])
  })

  // TBD4545/APP6233, ADO builds 378968 and 379017: a retention change inside
  // blob_properties. The mirror shapes are from a real azurerm 4.81.0 plan.
  it('descends through nested-block lists to the changed leaf', () => {
    const blob = (days: number) => [
      {
        change_feed_enabled: false,
        container_delete_retention_policy: [{ days }],
        cors_rule: [],
        delete_retention_policy: [{ days, permanent_delete_enabled: false }],
        last_access_time_enabled: false,
        restore_policy: [],
        versioning_enabled: false,
      },
    ]
    const mirror = {
      blob_properties: [
        { container_delete_retention_policy: [{}], cors_rule: [], delete_retention_policy: [{}], restore_policy: [] },
      ],
      primary_access_key: true,
    }
    expect(
      rows(
        { blob_properties: blob(7), primary_access_key: 'K1' },
        { blob_properties: blob(30), primary_access_key: 'K2' },
        { before_sensitive: mirror, after_sensitive: mirror },
      ),
    ).toEqual([
      { name: 'blob_properties[0].container_delete_retention_policy[0].days', before: '7', after: '30' },
      { name: 'blob_properties[0].delete_retention_policy[0].days', before: '7', after: '30' },
      { name: 'primary_access_key', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('reports only the elements that changed in lists of one length', () => {
    expect(rows({ ips: ['a', 'b', 'c'] }, { ips: ['a', 'x', 'c'] })).toEqual([{ name: 'ips[1]', before: 'b', after: 'x' }])
  })

  it('keeps a list of a different length as one row', () => {
    expect(rows({ ips: ['a'] }, { ips: ['a', 'b'] })).toEqual([{ name: 'ips', before: '["a"]', after: '["a","b"]' }])
    // Also when an element they share differs: index rows would hide the length change.
    expect(rows({ ips: ['a'] }, { ips: ['x', 'b'] })).toEqual([{ name: 'ips', before: '["a"]', after: '["x","b"]' }])
    expect(rows({ ips: ['a', 'b'] }, { ips: ['x'] })).toEqual([{ name: 'ips', before: '["a","b"]', after: '["x"]' }])
  })

  it('keeps one row when the two sides are different kinds', () => {
    expect(rows({ blk: null }, { blk: { a: 1 } })).toEqual([{ name: 'blk', before: null, after: '{"a":1}' }])
    expect(rows({ blk: [{ a: 1 }] }, { blk: { a: 1 } })).toEqual([{ name: 'blk', before: '[{"a":1}]', after: '{"a":1}' }])
  })

  it('keeps one row when only a null member against an absent one differs', () => {
    // Member by member they are equal; the whole values are not.
    expect(rows({ blk: { a: 1, x: null } }, { blk: { a: 1 } })).toEqual([
      { name: 'blk', before: '{"a":1,"x":null}', after: '{"a":1}' },
    ])
  })

  it('emits rows depth-first, members in code-point order', () => {
    expect(
      rows({ a: { z: 1, b: [{ y: 1, x: 1 }] }, c: 1 }, { a: { z: 2, b: [{ y: 2, x: 2 }] }, c: 2 }).map((r) => r.name),
    ).toEqual(['a.b[0].x', 'a.b[0].y', 'a.z', 'c'])
  })

  it('stops at MAX_ATTR_PATH_DEPTH segments and emits the rest whole', () => {
    let b: unknown = 'old'
    let a: unknown = 'new'
    for (let i = 0; i < MAX_ATTR_PATH_DEPTH + 2; i++) {
      b = { n: b }
      a = { n: a }
    }
    expect(rows({ deep: b }, { deep: a })).toEqual([
      { name: 'deep' + '.n'.repeat(MAX_ATTR_PATH_DEPTH), before: '{"n":{"n":"old"}}', after: '{"n":{"n":"new"}}' },
    ])
  })

  it('does not descend into a member whose name would pass MAX_ATTR_PATH_CODE_POINTS', () => {
    const long = 'k'.repeat(MAX_ATTR_PATH_CODE_POINTS)
    expect(rows({ tags: { [long]: 'a', short: 'a' } }, { tags: { [long]: 'b', short: 'b' } })).toEqual([
      { name: 'tags', before: fmt({ [long]: 'a', short: 'a' }), after: fmt({ [long]: 'b', short: 'b' }) },
    ])
    // At the bound exactly, it does.
    const fits = 'k'.repeat(MAX_ATTR_PATH_CODE_POINTS - 'tags.'.length)
    expect(rows({ tags: { [fits]: 'a' } }, { tags: { [fits]: 'b' } })).toEqual([
      { name: `tags.${fits}`, before: 'a', after: 'b' },
    ])
  })

  it('counts the name bound in code points, not UTF-16 units', () => {
    const key = '\u{1F600}'.repeat(MAX_ATTR_PATH_CODE_POINTS - 'tags[""]'.length) // twice the units, within the bound
    expect(rows({ tags: { [key]: 'a' } }, { tags: { [key]: 'b' } }).map((r) => r.name)).toEqual([`tags["${key}"]`])
  })

  it('counts rows against maxAttrsPerEntry, and the rest as omitted', () => {
    const many = (n: number, v: string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${String(i).padStart(2, '0')}`, v]))
    const r = summarize(change({ tags: many(60, 'a') }, { tags: many(60, 'b') }))
    expect(r.summary[0].attrs).toHaveLength(50)
    expect(r.summary[0].attrs![49].name).toBe('tags.t49')
    expect([r.omitted_attrs, r.truncated]).toEqual([10, true])
  })

  // The adversarial review's c01: 50 changed keys in a map that sorts first
  // took the whole row budget, and the image change after it had no row.
  it('leaves a row for every changed key after a large expansion', () => {
    const many = (v: string) => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${String(i).padStart(2, '0')}`, v]))
    const r = summarize(change({ tags: many('a'), z: 'org/app:1.0' }, { tags: many('b'), z: 'evil/backdoor:latest' }))
    const names = r.summary[0].attrs!.map((a) => a.name)
    expect(names).toHaveLength(50)
    expect(names[48]).toBe('tags.t48')
    expect(r.summary[0].attrs![49]).toEqual({ name: 'z', before: 'org/app:1.0', after: 'evil/backdoor:latest' })
    expect([r.omitted_attrs, r.truncated]).toEqual([11, true])
  })

  it('gives the first maxAttrsPerEntry changed keys one row each when more keys changed', () => {
    const keys = Array.from({ length: 55 }, (_, i) => `k${String(i).padStart(2, '0')}`)
    const side = (v: string) => Object.fromEntries(keys.map((k) => [k, { a: v, b: v }]))
    const r = summarize(change(side('1'), side('2')))
    // Each of the first 50 keys gets its first changed member; the rest is counted.
    expect(r.summary[0].attrs!.map((a) => a.name)).toEqual(keys.slice(0, 50).map((k) => `${k}.a`))
    expect(r.omitted_attrs).toBe(55 * 2 - 50)
  })

  it('leaves a scalar change exactly as before', () => {
    expect(rows({ sku: 'Standard' }, { sku: 'Premium' })).toEqual([{ name: 'sku', before: 'Standard', after: 'Premium' }])
  })

  it('no nesting depth of value or mirror makes it throw', () => {
    const depth = 50_000
    const deep = (leaf: string) => JSON.parse('['.repeat(depth) + leaf + ']'.repeat(depth))
    const name = 'v' + '[0]'.repeat(MAX_ATTR_PATH_DEPTH)
    expect(rows({ v: deep('1') }, { v: deep('2') }).map((r) => r.name)).toEqual([name])
    expect(rows({ v: deep('1') }, { v: deep('2') }, { before_sensitive: { v: deep('true') }, after_sensitive: {} })).toEqual([
      { name, before: '(sensitive)', after: '(sensitive)' },
    ])
  })
})
