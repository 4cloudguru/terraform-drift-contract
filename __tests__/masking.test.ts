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

  it('a NESTED non-empty mark on a top-level key masks that whole key', () => {
    const a = attr(
      update({
        before: { creds: { user: 'u', pass: SECRET } },
        after: { creds: { user: 'u', pass: SECRET + '2' } },
        before_sensitive: { creds: { pass: true } },
        after_sensitive: { creds: { pass: true } },
      }),
      'creds',
    )
    expect(a).toEqual({ name: 'creds', before: '(sensitive)', after: '(sensitive)' })
  })

  it('an ARRAY-POSITIONED mark masks the whole key', () => {
    const a = attr(
      update({
        before: { keys: ['public', SECRET] },
        after: { keys: ['public', SECRET + '2'] },
        before_sensitive: { keys: [false, true] },
        after_sensitive: { keys: [false, true] },
      }),
      'keys',
    )
    expect(a).toEqual({ name: 'keys', before: '(sensitive)', after: '(sensitive)' })
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

  // The mask is per TOP-LEVEL changed key, evaluated against
  // before_sensitive[k] only. A secret nested under an UNMARKED key is
  // serialised whole. Also documented in SECURITY.md; pinned here so the
  // residual is visible rather than assumed away.
  it('a secret nested under an UNMARKED top-level key is emitted (documented residual)', () => {
    const a = attr(
      update({
        before: { config: { note: 'a', pass: SECRET } },
        after: { config: { note: 'b', pass: SECRET } },
        before_sensitive: {},
        after_sensitive: {},
      }),
      'config',
    )
    expect(a?.before).toContain(SECRET)
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
})
