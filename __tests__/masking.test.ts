import { describe, expect, it } from 'vitest'
import { isSens, summarize, type AttrChange, type Plan } from '../src/index'

// The redaction control was tested only on its happy path: one fixture whose
// metadata is the perfectly symmetric {"password": true} on BOTH sides. Every
// shape that DISABLES the control — absent, falsy, one-sided, nested-only — was
// unasserted, so a refactor that removed masking for any of them would have
// shipped green. These rows pin the actual behaviour, including the two places
// where it is deliberately fail-open, so those are visible in review rather than
// discovered by a leak.
//
// Mutation rule: delete the `sensitive ? '(sensitive)' :` branch in
// summarize.ts and every "masks" row here must fail.

const SECRET = 'S3CRET-do-not-emit'

function update(change: Record<string, unknown>): Plan {
  return { resource_changes: [{ address: 'aws_instance.x', change: { actions: ['update'], ...change } }] }
}

function attrs(plan: Plan): AttrChange[] {
  return summarize(plan).summary[0]?.attrs ?? []
}

function attr(plan: Plan, name: string): AttrChange | undefined {
  return attrs(plan).find((a) => a.name === name)
}

describe('masking: metadata shapes that keep the control ON', () => {
  it('symmetric true/true masks both sides', () => {
    const a = attr(
      update({
        before: { password: SECRET },
        after: { password: SECRET + '2' },
        before_sensitive: { password: true },
        after_sensitive: { password: true },
      }),
      'password',
    )
    expect(a).toEqual({ name: 'password', before: '(sensitive)', after: '(sensitive)' })
  })

  // Terraform applies a config-derived mark to the PLANNED value only, so a
  // credential routinely arrives marked on exactly one side. Masking per-side
  // would emit the other side in cleartext.
  it.each([
    ['marked on before only', { password: true }, {}],
    ['marked on after only', {}, { password: true }],
    ['marked on before, after_sensitive absent', { password: true }, undefined],
    ['marked on after, before_sensitive absent', undefined, { password: true }],
  ])('%s masks BOTH sides (union, not per-side)', (_label, bs, as_) => {
    const change: Record<string, unknown> = { before: { password: SECRET }, after: { password: SECRET + '2' } }
    if (bs !== undefined) change.before_sensitive = bs
    if (as_ !== undefined) change.after_sensitive = as_
    const a = attr(update(change), 'password')
    expect(a).toEqual({ name: 'password', before: '(sensitive)', after: '(sensitive)' })
  })

  it('a NESTED mark masks the marked member, and the key is expanded to reach it', () => {
    expect(
      attrs(
        update({
          before: { creds: { user: 'u', pass: SECRET } },
          after: { creds: { user: 'v', pass: SECRET + '2' } },
          before_sensitive: { creds: { pass: true } },
          after_sensitive: { creds: { pass: true } },
        }),
      ),
    ).toEqual([
      { name: 'creds.pass', before: '(sensitive)', after: '(sensitive)' },
      { name: 'creds.user', before: 'u', after: 'v' },
    ])
  })

  it('an ARRAY-POSITIONED mark masks that element', () => {
    expect(
      attrs(
        update({
          before: { keys: ['public', SECRET] },
          after: { keys: ['public2', SECRET + '2'] },
          before_sensitive: { keys: [false, true] },
          after_sensitive: { keys: [false, true] },
        }),
      ),
    ).toEqual([
      { name: 'keys[0]', before: 'public', after: 'public2' },
      { name: 'keys[1]', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('a mark on one side masks that member on BOTH sides, at any depth', () => {
    expect(
      attrs(
        update({
          before: { blk: [{ inner: [{ pass: SECRET }] }] },
          after: { blk: [{ inner: [{ pass: SECRET + '2' }] }] },
          before_sensitive: { blk: [{ inner: [{}] }] },
          after_sensitive: { blk: [{ inner: [{ pass: true }] }] },
        }),
      ),
    ).toEqual([{ name: 'blk[0].inner[0].pass', before: '(sensitive)', after: '(sensitive)' }])
  })

  it('a mark on a block masks all of it, however it is nested', () => {
    // azurerm marks `connection_string` as a whole: the mirror is `true`, not a
    // member-by-member map, so nothing under it may be expanded into view.
    expect(
      attrs(
        update({
          before: { connection_string: [{ name: 'db', value: SECRET }] },
          after: { connection_string: [{ name: 'db2', value: SECRET + '2' }] },
          before_sensitive: { connection_string: true },
          after_sensitive: { connection_string: true },
        }),
      ),
    ).toEqual([{ name: 'connection_string', before: '(sensitive)', after: '(sensitive)' }])
  })

  it('a value that is not expanded is masked whole when anything under it is marked', () => {
    // Lists of different lengths are one row; the mark inside masks that row.
    expect(
      attrs(
        update({
          before: { rules: [{ name: 'a', secret: SECRET }] },
          after: { rules: [{ name: 'a', secret: SECRET }, { name: 'b', secret: 'x' }] },
          before_sensitive: { rules: [{ secret: true }] },
          after_sensitive: { rules: [{ secret: true }, { secret: true }] },
        }),
      ),
    ).toEqual([{ name: 'rules', before: '(sensitive)', after: '(sensitive)' }])
  })

  it.each([
    ['an object mirror on an array value', { keys: { 0: true } }],
    ['an array mirror on an object value', { creds: [true] }],
    ['an array mirror on a string value', { pass: [true] }],
  ])('%s that marks anything masks the whole value (fail-closed)', (_label, mirror) => {
    const before = { keys: ['public', SECRET], creds: { user: 'u', pass: SECRET }, pass: SECRET }
    const after = { keys: ['public', SECRET + '2'], creds: { user: 'u', pass: SECRET + '2' }, pass: SECRET + '2' }
    const name = Object.keys(mirror)[0]
    const rows = attrs(update({ before, after, before_sensitive: mirror, after_sensitive: {} }))
    // One row for the key, masked, and nothing expanded under it.
    expect(rows.filter((a) => a.name.startsWith(name))).toEqual([{ name, before: '(sensitive)', after: '(sensitive)' }])
  })

  it.each([
    ['a string', 'yes'],
    ['a number', 1],
    ['a string inside a container', ['yes']],
    ['a number inside a container', { x: [2] }],
  ])('a truthy non-boolean mark (%s) masks, where it used to be read as no mark', (_label, mark) => {
    const a = attr(
      update({ before: { pw: SECRET }, after: { pw: SECRET + '2' }, before_sensitive: { pw: mark }, after_sensitive: {} }),
      'pw',
    )
    expect(a).toEqual({ name: 'pw', before: '(sensitive)', after: '(sensitive)' })
  })
})

describe('masking: a marked value is masked wherever else it appears in the change', () => {
  // Marks are aligned by path, and a value can change path between the sides.
  // These are the adversarial review's r01–r06 and x0 shapes.
  it('moved to another index (refresh re-applies prior marks by path)', () => {
    expect(
      attrs(
        update({
          before: { args: [SECRET, 'x'] },
          after: { args: ['x', SECRET] },
          before_sensitive: { args: [true, false] },
          after_sensitive: { args: [true, false] },
        }),
      ),
    ).toEqual([
      { name: 'args[0]', before: '(sensitive)', after: '(sensitive)' },
      { name: 'args[1]', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('moved to another map key alongside a config-derived mark', () => {
    expect(
      attrs(
        update({
          before: { app_settings: { DB_PASS: SECRET, X: '1' } },
          after: { app_settings: { DB_PASSWORD: SECRET, X: '1' } },
          before_sensitive: { app_settings: {} },
          after_sensitive: { app_settings: { DB_PASSWORD: true } },
        }),
      ),
    ).toEqual([
      { name: 'app_settings.DB_PASS', before: '(sensitive)', after: '(sensitive)' },
      { name: 'app_settings.DB_PASSWORD', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('in another attribute, including one that did not change', () => {
    const rows = attrs(
      update({
        before: { key: SECRET, note: 'a', other: ['x'] },
        after: { key: SECRET, note: SECRET, other: ['x', SECRET] },
        before_sensitive: { key: true },
        after_sensitive: { key: true },
      }),
    )
    expect(rows).toEqual([
      { name: 'note', before: '(sensitive)', after: '(sensitive)' },
      { name: 'other', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('marked only by the OTHER side’s mirror (the union applies to marked values too)', () => {
    // A config-derived mark on the after side only: the old plaintext is unmarked
    // in before_sensitive, and turns up in another attribute.
    expect(
      attrs(
        update({
          before: { pw: SECRET, note: 'a' },
          after: { pw: 'new', note: SECRET },
          before_sensitive: {},
          after_sensitive: { pw: true },
        }),
      ),
    ).toEqual([
      { name: 'note', before: '(sensitive)', after: '(sensitive)' },
      { name: 'pw', before: '(sensitive)', after: '(sensitive)' },
    ])
  })

  it('as a map key, which is never expanded into a row name', () => {
    const rows = attrs(
      update({
        before: { key: SECRET, tags: { a: '1' } },
        after: { key: SECRET, tags: { a: '1', [SECRET]: '1' } },
        before_sensitive: { key: true },
        after_sensitive: { key: true },
      }),
    )
    expect(rows).toEqual([{ name: 'tags', before: '(sensitive)', after: '(sensitive)' }])
  })

  it('keys under a marked map are marked values too', () => {
    const rows = attrs(
      update({
        before: { app_settings: { [SECRET]: '1' }, note: 'a' },
        after: { app_settings: { [SECRET]: '2' }, note: SECRET },
        before_sensitive: { app_settings: true },
        after_sensitive: { app_settings: true },
      }),
    )
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  // Those are not held as marked values, so the path rule is their only mask.
  it.each([
    ['on both sides', { blk: [{ flag: true }] }],
    ['on the after side only', { blk: [{}] }],
  ])('a marked boolean in a nested block is masked at its path, %s', (_label, beforeSensitive) => {
    expect(
      attrs(
        update({
          before: { blk: [{ flag: true, name: 'x' }] },
          after: { blk: [{ flag: false, name: 'y' }] },
          before_sensitive: beforeSensitive,
          after_sensitive: { blk: [{ flag: true }] },
        }),
      ),
    ).toEqual([
      { name: 'blk[0].flag', before: '(sensitive)', after: '(sensitive)' },
      { name: 'blk[0].name', before: 'x', after: 'y' },
    ])
  })

  it.each([
    ['an empty string', ''],
    ['a boolean', true],
    ['null', null],
  ])('a marked %s does not mask other rows that hold it', (_label, v) => {
    const rows = attrs(
      update({
        before: { pw: v, a: v, b: 'x' },
        after: { pw: v, a: 'y', b: v },
        before_sensitive: { pw: true },
        after_sensitive: { pw: true },
      }),
    )
    expect(rows.every((r) => r.before !== '(sensitive)')).toBe(true)
  })

  it('a number and the string of it are distinct marked values', () => {
    const rows = attrs(
      update({
        before: { pin: 1234, a: 'x', b: 'x' },
        after: { pin: 1234, a: 1234, b: '1234' },
        before_sensitive: { pin: true },
        after_sensitive: { pin: true },
      }),
    )
    expect(rows).toEqual([
      { name: 'a', before: '(sensitive)', after: '(sensitive)' },
      { name: 'b', before: 'x', after: '1234' },
    ])
  })

  // Documented residual: exact values only.
  it('a value that merely contains a marked value is emitted', () => {
    const rows = attrs(
      update({
        before: { key: SECRET, note: 'a' },
        after: { key: SECRET, note: `key is ${SECRET}` },
        before_sensitive: { key: true },
        after_sensitive: { key: true },
      }),
    )
    expect(rows).toEqual([{ name: 'note', before: 'a', after: `key is ${SECRET}` }])
  })
})

describe('masking: containers without a mark are not sensitive', () => {
  // Terraform writes a mirror container for every nested block and every list,
  // marked or not. Up to v1.4.2 any non-empty one masked the whole key.
  it.each([
    ['a nested block (azurerm 4.81 blob_properties)', [{ container_delete_retention_policy: [{}], cors_rule: [], delete_retention_policy: [{}], restore_policy: [] }]],
    ['a list of strings (address_space)', [false, false]],
    ['a map with no marked element', {}],
    ['nested empty containers', [{ a: [{ b: [] }] }]],
  ])('%s', (_label, mirror) => {
    const row = attr(
      update({ before: { v: 'old' }, after: { v: 'new' }, before_sensitive: { v: mirror }, after_sensitive: { v: mirror } }),
      'v',
    )
    expect(row).toEqual({ name: 'v', before: 'old', after: 'new' })
  })
})

describe('masking: metadata shapes that leave the control OFF', () => {
  // DELIBERATE and documented in SECURITY.md: with neither mirror present,
  // nothing is masked. Masking here would mask every attribute of every such
  // plan and would diverge from the Go mirror, which fails open identically.
  // Pinned so the fail-open is a decision on the record, not an accident.
  it('NEITHER mirror present: nothing is masked (deliberate fail-open)', () => {
    const a = attr(update({ before: { password: SECRET }, after: { password: SECRET + '2' } }), 'password')
    expect(a).toEqual({ name: 'password', before: SECRET, after: SECRET + '2' })
  })

  it.each([
    ['false', false],
    ['0', 0],
    ['empty string', ''],
    ['empty object', {}],
    ['null', null],
  ])('a falsy mark (%s) does not mask', (_label, mark) => {
    const a = attr(
      update({
        before: { password: SECRET },
        after: { password: SECRET + '2' },
        before_sensitive: { password: mark },
        after_sensitive: { password: mark },
      }),
      'password',
    )
    expect(a?.before).toBe(SECRET)
  })

  // The mask is driven entirely by the mirrors. A secret whose path carries no
  // mark in either of them is emitted, at any depth. Also documented in
  // SECURITY.md; pinned here so the residual is visible rather than assumed away.
  it('a nested secret whose path is UNMARKED is emitted (documented residual)', () => {
    const a = attr(
      update({
        before: { config: { note: 'a', pass: SECRET } },
        after: { config: { note: 'a', pass: SECRET + '2' } },
        before_sensitive: {},
        after_sensitive: {},
      }),
      'config.pass',
    )
    expect(a?.before).toBe(SECRET)
  })
})

describe('masking: the predicate itself', () => {
  it('is unaffected by a polluted Object.prototype', () => {
    const polluted = Object.prototype as unknown as Record<string, unknown>
    try {
      polluted.password = true
      // An own JSON property always shadows an inherited one, so pollution could
      // only ever OVER-mask; the own-property guard removes even that.
      expect(isSens({}, 'password')).toBe(false)
      const a = attr(
        update({
          before: { password: SECRET },
          after: { password: SECRET + '2' },
          before_sensitive: {},
          after_sensitive: {},
        }),
        'password',
      )
      expect(a?.before).toBe(SECRET)
    } finally {
      delete polluted.password
    }
  })

  it('reads no inherited member as a mark', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isSens({}, k)).toBe(false)
    }
  })

  it('reads no inherited member of a NESTED mirror as a mark either', () => {
    const polluted = Object.prototype as unknown as Record<string, unknown>
    const pollutedArray = Array.prototype as unknown as Record<string, unknown>
    try {
      polluted.pass = true
      pollutedArray[1] = true
      // Own reads only: the walk must not find these, or it would over-mask.
      expect(
        attrs(
          update({
            before: { creds: { pass: 'a' }, list: ['x', 'y'] },
            after: { creds: { pass: 'b' }, list: ['x', 'z'] },
            before_sensitive: { creds: {}, list: [false] },
            after_sensitive: { creds: {}, list: [false] },
          }),
        ),
      ).toEqual([
        { name: 'creds.pass', before: 'a', after: 'b' },
        { name: 'list[1]', before: 'y', after: 'z' },
      ])
    } finally {
      delete polluted.pass
      delete pollutedArray[1]
    }
  })

  it.each([
    [{ k: true }, true],
    [{ k: [false, true] }, true],
    [{ k: [{ a: [{ b: true }] }] }, true],
    [{ k: 'yes' }, true],
    [{ k: [false, false] }, false],
    [{ k: [{ a: [{}] }] }, false],
    [{ k: [] }, false],
    [true, true],
    [[true], true],
    [false, false],
    [{}, false],
  ])('isSens(%j, "k") is %s: a mark is a truthy scalar at any depth', (mirror, want) => {
    expect(isSens(mirror, 'k')).toBe(want)
  })
})
