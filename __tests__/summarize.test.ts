import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { summarize, moduleCallsPlan, fmt, isSens, Plan } from '../src/summarize'

const load = (name: string): Plan =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))

// These assertions ARE the contract's vectors: the backend's driftingest and the
// jq in its dispatched CI templates are diffed against them. Keep them in
// lockstep — a change here obliges a matching change there (see SECURITY.md).
describe('summarize — counts, skip rules, drifted', () => {
  it('mixed plan: +2 ~1 -2, drifted, no-op AND read both excluded from summary', () => {
    const r = summarize(load('mixed.json'))
    expect([r.added, r.changed, r.destroyed]).toEqual([2, 1, 2])
    expect(r.drifted).toBe(true)
    // new, tweak, gone, replaced — NOT same(no-op) and NOT data.aws_ami.x(read)
    expect(r.summary.map((e) => e.address)).toEqual([
      'aws_instance.new',
      'aws_instance.tweak',
      'aws_instance.gone',
      'aws_instance.replaced',
    ])
    expect(r.summary.find((e) => e.address === 'aws_instance.replaced')?.actions).toEqual(['delete', 'create'])
  })

  it('no-op-only plan is clean', () => {
    const r = summarize(load('clean.json'))
    expect([r.added, r.changed, r.destroyed, r.drifted]).toEqual([0, 0, 0, false])
    expect(r.summary).toEqual([])
  })

  it('read-only plan is clean and produces an EMPTY summary (read is skipped)', () => {
    const r = summarize(load('read-only.json'))
    expect(r.drifted).toBe(false)
    expect(r.summary).toEqual([])
  })

  it('is null-safe', () => {
    const r = summarize(null)
    expect(r).toEqual({ added: 0, changed: 0, destroyed: 0, drifted: false, summary: [] })
  })
})

describe('summarize — attrs extraction + sensitive masking', () => {
  const tweak = () => summarize(load('mixed.json')).summary.find((e) => e.address === 'aws_instance.tweak')!

  it('emits only changed top-level keys (unchanged nested object is skipped via deep equality)', () => {
    expect(tweak().attrs?.map((a) => a.name)).toEqual(['instance_type', 'password']) // tags unchanged → absent
  })

  it('masks sensitive values to the literal "(sensitive)" and formats the rest', () => {
    const attrs = tweak().attrs!
    expect(attrs.find((a) => a.name === 'instance_type')).toEqual({ name: 'instance_type', before: 't3.micro', after: 't3.large' })
    expect(attrs.find((a) => a.name === 'password')).toEqual({ name: 'password', before: '(sensitive)', after: '(sensitive)' })
  })

  it('pure create (before=null) and pure delete (after=null) get no attrs', () => {
    const s = summarize(load('mixed.json')).summary
    expect(s.find((e) => e.address === 'aws_instance.new')?.attrs).toBeUndefined()
    expect(s.find((e) => e.address === 'aws_instance.gone')?.attrs).toBeUndefined()
  })
})

describe('fmt + isSens (verbatim parity helpers)', () => {
  it('fmt passes strings through, compacts+sorts objects, truncates at 300 with U+2026', () => {
    expect(fmt(null)).toBeNull()
    expect(fmt('short')).toBe('short')
    expect(fmt({ b: 1, a: 2 })).toBe('{"a":2,"b":1}') // sorted keys, compact
    const long = 'x'.repeat(305)
    const out = fmt(long)!
    expect(Array.from(out).length).toBe(301) // 300 + the … marker
    expect(out.endsWith('…')).toBe(true)
  })

  it('isSens follows python bool semantics (True / non-empty nested → mask)', () => {
    expect(isSens({ k: true }, 'k')).toBe(true)
    expect(isSens({ k: false }, 'k')).toBe(false)
    expect(isSens({ k: { nested: true } }, 'k')).toBe(true) // non-empty nested dict
    expect(isSens({ k: {} }, 'k')).toBe(false) // empty dict → not sensitive
    expect(isSens(true, 'anything')).toBe(true) // whole-value sensitive
    expect(isSens({}, 'missing')).toBe(false)
  })
})

describe('moduleCallsPlan', () => {
  it('forwards only the module_calls subdocument', () => {
    expect(moduleCallsPlan(load('mixed.json'))).toEqual({
      configuration: { root_module: { module_calls: { vpc: { source: 'myorg/vpc/aws', version_constraint: '~> 5.0' } } } },
    })
    expect(moduleCallsPlan(null)).toEqual({ configuration: { root_module: { module_calls: {} } } })
  })
})

// ---------------------------------------------------------------------------
// Defect class: "a sensitive value reaches the emitted summary because a masking
// control is applied asymmetrically, bypassed on one path, or defaults open when
// its metadata is absent." One table over the whole masking surface — every
// emitting path of the package (attrs + module provenance), every shape of the
// sensitivity metadata. Each row must fail if its guard is removed.
// ---------------------------------------------------------------------------
const SECRET = 'TOKEN-OLD-abc123'

/** One in-place update of a single attribute, with the mirrors under test. */
const update = (change: Record<string, unknown>): Plan => ({
  resource_changes: [{ address: 'aws_instance.x', change: { actions: ['update'], ...change } }],
})

const attrsOf = (plan: Plan) => summarize(plan).summary[0].attrs

const modulePlan = (module_calls: Record<string, unknown>): Plan => ({
  configuration: { root_module: { module_calls } },
})

const callsOf = (plan: Plan) =>
  (moduleCallsPlan(plan) as { configuration: { root_module: Record<string, unknown> } }).configuration.root_module

interface Row {
  name: string
  got: () => unknown
  want: unknown
}

const rows: Row[] = [
  {
    // #7: config-derived sensitivity marks the PLANNED value only, so the prior
    // secret read back from state is unmarked — and was emitted verbatim.
    name: 'attrs: before_sensitive absent, after_sensitive set → BOTH sides masked',
    got: () =>
      attrsOf(
        update({
          before: { user_data: SECRET },
          after: { user_data: 'TOKEN-NEW-def456' },
          after_sensitive: { user_data: true },
        }),
      ),
    want: [{ name: 'user_data', before: '(sensitive)', after: '(sensitive)' }],
  },
  {
    // The reverse: an attribute that STOPS being config-sensitive.
    name: 'attrs: before_sensitive set, after_sensitive absent → BOTH sides masked',
    got: () =>
      attrsOf(
        update({
          before: { user_data: SECRET },
          after: { user_data: 'TOKEN-NEW-def456' },
          before_sensitive: { user_data: true },
        }),
      ),
    want: [{ name: 'user_data', before: '(sensitive)', after: '(sensitive)' }],
  },
  {
    name: 'attrs: both mirrors set → unchanged, byte-identical to the pre-fix output',
    got: () =>
      attrsOf(
        update({
          before: { password: 'old' },
          after: { password: 'new' },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
        }),
      ),
    want: [{ name: 'password', before: '(sensitive)', after: '(sensitive)' }],
  },
  {
    // Neither mirror present = no sensitivity metadata at all (a pre-0.15 or
    // non-terraform producer). Masking here would mask EVERY attribute of EVERY
    // such plan and make the summary useless, so this stays open BY DESIGN and
    // is asserted so the decision cannot drift silently. Documented in README.
    name: 'attrs: neither mirror present → nothing masked (documented, deliberate)',
    got: () => attrsOf(update({ before: { instance_type: 't3.micro' }, after: { instance_type: 't3.large' } })),
    want: [{ name: 'instance_type', before: 't3.micro', after: 't3.large' }],
  },
  {
    name: 'attrs: nested/structured mark on one side only → masked',
    got: () =>
      attrsOf(
        update({
          before: { tags: { token: SECRET } },
          after: { tags: { token: 'new' } },
          after_sensitive: { tags: { token: true } },
        }),
      ),
    want: [{ name: 'tags', before: '(sensitive)', after: '(sensitive)' }],
  },
  {
    name: 'attrs: whole-value mark on one side only (before_sensitive: true) → masked',
    got: () =>
      attrsOf(update({ before: { password: SECRET }, after: { password: 'new' }, before_sensitive: true })),
    want: [{ name: 'password', before: '(sensitive)', after: '(sensitive)' }],
  },
  {
    // #8: `configuration` carries NO sensitivity metadata, so everything under
    // it is unredacted by construction — project, never forward.
    name: 'module_calls: secret-shaped subtree → only scrubbed source + version_constraint survive',
    got: () =>
      callsOf(
        modulePlan({
          db: {
            source: 'git::https://x-access-token:ghp_AAAABBBBCCCC@github.com/org/mod.git?ref=v1.2.3&sshkey=PRIVATEKEY',
            version_constraint: '~> 5.0',
            expressions: { admin_password: { constant_value: 'P@ssw0rd-literal' } },
            module: {
              resources: [{ address: 'aws_db_instance.d', expressions: { password: { constant_value: 'nested-secret' } } }],
              variables: { pw: { default: 'default-secret', sensitive: true } },
            },
          },
        }),
      ),
    want: {
      module_calls: {
        db: {
          source: 'git::https://(redacted)@github.com/org/mod.git?ref=v1.2.3&sshkey=(redacted)',
          version_constraint: '~> 5.0',
        },
      },
    },
  },
  {
    name: 'module_calls: non-string source/version_constraint are dropped, not serialised',
    got: () =>
      callsOf(modulePlan({ db: { source: { secret: SECRET }, version_constraint: ['~> 5.0'], module: {} } })),
    want: { module_calls: { db: {} } },
  },
  {
    name: 'module_calls: an oversized source is capped at 300 code points like every other value',
    got: () => {
      const src = callsOf(modulePlan({ db: { source: 'x'.repeat(5000) } })) as {
        module_calls: { db: { source: string } }
      }
      return Array.from(src.module_calls.db.source).length
    },
    want: 301, // 300 + the U+2026 marker
  },
  {
    name: 'module_calls: an oversized subtree is capped at 100 entries and flagged truncated',
    got: () => {
      const many: Record<string, unknown> = {}
      for (let i = 0; i < 250; i++) many[`m${String(i).padStart(3, '0')}`] = { source: `org/m${i}/aws` }
      const rm = callsOf(modulePlan(many)) as { module_calls: Record<string, unknown>; module_calls_truncated?: boolean }
      const names = Object.keys(rm.module_calls)
      return { count: names.length, first: names[0], last: names[names.length - 1], truncated: rm.module_calls_truncated }
    },
    want: { count: 100, first: 'm000', last: 'm099', truncated: true },
  },
  {
    name: 'module_calls: an oversized module NAME is capped too, so the document stays bounded',
    got: () => {
      const rm = callsOf(modulePlan({ ['n'.repeat(5000)]: { source: 'org/m/aws' } })) as {
        module_calls: Record<string, unknown>
      }
      return Object.keys(rm.module_calls).map((k) => Array.from(k).length)
    },
    want: [301],
  },
]

describe('defect class: sensitive values must never reach the emitted output', () => {
  it.each(rows)('$name', ({ got, want }) => {
    expect(got()).toEqual(want)
  })

  it('no row leaves a secret anywhere in the serialised output', () => {
    for (const row of rows) {
      const s = JSON.stringify(row.got())
      expect(s).not.toContain(SECRET)
      expect(s).not.toContain('ghp_')
      expect(s).not.toContain('P@ssw0rd-literal')
      expect(s).not.toContain('nested-secret')
      expect(s).not.toContain('default-secret')
      expect(s).not.toContain('PRIVATEKEY')
    }
  })
})
