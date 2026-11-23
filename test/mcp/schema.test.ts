// The tool arguments are checked against the tool's own inputSchema, and the operation schema agrees
// with the domain's reader of operations.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ENTRY_TYPES } from '../../src/domain/entries.ts'
import { OP_KINDS, type Problem, readOp } from '../../src/domain/wiki/model.ts'
import { OP_EXAMPLES, OP_SCHEMAS, OPS_SCHEMA } from '../../src/domain/wiki/op-schema.ts'
import { INSTRUCTIONS } from '../../src/mcp/instructions.ts'
import { TOOLS } from '../../src/mcp/tools.ts'
import { validateArgs } from '../../src/mcp/validate.ts'

const tool = (name: string) => TOOLS.find((t) => t.name === name) as (typeof TOOLS)[number]
type Json = Record<string, unknown>

describe('validateArgs', () => {
  it('E1: a missing required field and an unknown one are both named', () => {
    const p = validateArgs(tool('mem_search').inputSchema, { query: 'x' })
    assert.ok(
      p.some((m) => /"query"/.test(m) && /unknown/i.test(m)),
      p.join(' | '),
    )
    assert.ok(
      p.some((m) => /"q"/.test(m) && /required/i.test(m)),
      p.join(' | '),
    )
    assert.deepEqual(validateArgs(tool('mem_search').inputSchema, {}), ['"q" is required.'])
    assert.ok(validateArgs(tool('mem_search').inputSchema, { bogus: 1 }).some((m) => /"bogus"/.test(m)))
  })

  it('E1: basic types, enums, bounds and nested lists', () => {
    const s = tool('mem_search').inputSchema
    assert.deepEqual(validateArgs(s, { q: 'a', limit: 5, in: 'both', brains: ['x'] }), [])
    assert.match(validateArgs(s, { q: 1 })[0] ?? '', /"q" must be text/)
    assert.match(validateArgs(s, { q: 'a', limit: 1.5 })[0] ?? '', /"limit" must be a whole number/)
    assert.match(validateArgs(s, { q: 'a', limit: 99 })[0] ?? '', /"limit" must be at most 50/)
    assert.match(
      validateArgs(s, { q: 'a', in: 'nope' })[0] ?? '',
      /"in" must be one of: entries, pages, both/,
    )
    assert.match(validateArgs(s, { q: 'a', brains: 'x' })[0] ?? '', /"brains" must be a list/)
    assert.match(validateArgs(s, { q: 'a', brains: [3] })[0] ?? '', /brains\[0\]" must be text/)
    assert.match(
      validateArgs(s, { q: 'a', neighbours: 'yes' })[0] ?? '',
      /"neighbours" must be true or false/,
    )
  })

  it('E1: null on an optional field counts as left out; on a required one it is missing', () => {
    const s = tool('mem_search').inputSchema
    assert.deepEqual(validateArgs(s, { q: 'a', limit: null }), [])
    assert.deepEqual(validateArgs(s, { q: null }), ['"q" is required.'])
  })

  it('mem_session_start with "goal" instead of "purpose" is an unknown field', () => {
    const p = validateArgs(tool('mem_session_start').inputSchema, { goal: 'ship' })
    assert.match(p.join(' '), /"goal"/)
    assert.match(p.join(' '), /purpose/)
  })

  it('every tool accepts the empty arguments exactly when it has no required field', () => {
    for (const t of TOOLS) {
      const required = ((t.inputSchema.required as string[]) ?? []).length
      assert.equal(validateArgs(t.inputSchema, {}).length > 0, required > 0, t.name)
    }
  })
})

describe('E2: the types an agent may save', () => {
  const agent = ENTRY_TYPES.filter((t) => t !== 'correction')
  it('the enum of mem_save is the domain list without "correction"', () => {
    const props = tool('mem_save').inputSchema.properties as Record<string, { enum?: string[] }>
    assert.deepEqual(props.type?.enum, agent)
    const upd = tool('mem_update').inputSchema.properties as Record<string, { enum?: string[] }>
    assert.deepEqual(upd.type?.enum, agent)
  })
  it('the description and the instructions name only types the server accepts', () => {
    const d = String(((tool('mem_save').inputSchema.properties as Json).type as Json).description)
    for (const t of agent) assert.ok(d.includes(t), `${t} missing in "${d}"`)
    assert.match(d, /correction/)
    assert.doesNotMatch(d, /discovery/)
    assert.doesNotMatch(INSTRUCTIONS, /each discovery/)
    assert.doesNotMatch(tool('mem_save').description, /discovery/)
  })
})

describe('the operation schema and the domain agree', () => {
  const branches = OP_SCHEMAS as Array<{
    properties: Record<string, { const?: string; enum?: string[] }>
    required: string[]
  }>
  const probe = (raw: Json): Problem[] => {
    const problems: Problem[] = []
    readOp(raw, 0, problems)
    return problems
  }
  it('one branch per operation kind, in the domain order', () => {
    assert.deepEqual(
      branches.map((b) => b.properties.op?.const),
      [...OP_KINDS],
    )
    assert.deepEqual(Object.keys(OP_EXAMPLES), [...OP_KINDS])
    assert.equal((OPS_SCHEMA.items as Json).oneOf, OP_SCHEMAS)
  })
  it('every example is a valid operation for the domain', () => {
    for (const k of OP_KINDS) assert.deepEqual(probe(OP_EXAMPLES[k]), [], k)
  })
  it('every example carries all the required fields and only fields of its branch', () => {
    for (const b of branches) {
      const ex = OP_EXAMPLES[b.properties.op?.const as (typeof OP_KINDS)[number]]
      for (const f of b.required) assert.ok(f in ex, `${b.properties.op?.const} example lacks ${f}`)
      for (const f of Object.keys(ex)) assert.ok(f in b.properties, `${f} is not in the schema`)
    }
  })
  it('a field the schema requires is one the domain requires (an agent cites sources for a new page)', () => {
    const checkedElsewhere = new Set(['create.sources'])
    for (const b of branches) {
      const k = b.properties.op?.const as string
      for (const f of b.required) {
        if (f === 'op' || checkedElsewhere.has(`${k}.${f}`)) continue
        const { [f]: _gone, ...rest } = OP_EXAMPLES[k as (typeof OP_KINDS)[number]]
        assert.ok(probe(rest).length > 0, `the domain accepts ${k} without "${f}"`)
      }
    }
  })
  it('the domain refuses a value outside every enum the schema declares', () => {
    for (const b of branches) {
      const k = b.properties.op?.const as string
      for (const [f, def] of Object.entries(b.properties)) {
        if (!def.enum) continue
        assert.ok(
          probe({ ...OP_EXAMPLES[k as (typeof OP_KINDS)[number]], [f]: 'zzz' }).length > 0,
          `${k}.${f}`,
        )
      }
    }
  })
  it('an operation without "op" says the field is missing', () => {
    const p = probe({ address: 'a/b', reason: 'x' })
    assert.match(p[0]?.message ?? '', /"op" is missing/)
    assert.doesNotMatch(p[0]?.message ?? '', /undefined/)
  })
  it('the validator picks the branch by "op" and names what that operation lacks', () => {
    const t = tool('brain_check').inputSchema
    assert.deepEqual(validateArgs(t, { ops: [OP_EXAMPLES.create] }), [])
    const noOp = validateArgs(t, { ops: [{ address: 'a/b', reason: 'x' }] })
    assert.match(noOp.join(' '), /ops\[0\]\.op" is missing/)
    const bad = validateArgs(t, { ops: [{ op: 'fly', address: 'a/b' }] })
    assert.match(bad.join(' '), /ops\[0\]\.op" must be one of: create, edit/)
    const lacking = validateArgs(t, { ops: [{ op: 'move', address: 'a/b' }] })
    assert.match(lacking.join(' '), /ops\[0\]\.to" is required/)
    assert.match(lacking.join(' '), /ops\[0\]\.reason" is required/)
  })
  it('E6: brain_check needs only ops', () => {
    assert.deepEqual(tool('brain_check').inputSchema.required, ['ops'])
    assert.deepEqual(validateArgs(tool('brain_check').inputSchema, { ops: [OP_EXAMPLES.move] }), [])
    assert.ok((tool('brain_propose').inputSchema.required as string[]).includes('title'))
  })
})
