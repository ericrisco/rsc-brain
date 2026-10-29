import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { newSecret } from '../../src/auth/secrets.ts'
import { normalize, PRIVATE_MARK, redact, redactAll, SECRET_MARK } from '../../src/privacy/redact.ts'

// Fake credentials with the real shapes (none of them is valid anywhere).
const SECRETS: Record<string, string> = {
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGh',
  openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  github: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS',
  gitlab: 'glpat-AbCdEfGhIjKlMnOpQrSt',
  slack: 'xoxb-1234567890-abcdefghijkl',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  stripe: 'sk_live_51H8abcdefghijklmnop',
  replicate: 'r8_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  huggingface: 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  npm: 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  telegram: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  brain: newSecret(),
}

const MUST_SURVIVE = [
  'commit 3f9c2a1e5b7d4c8a9e0f1b2c3d4e5f6a7b8c9d0e fixed it',
  'id 550e8400-e29b-41d4-a716-446655440000',
  'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'run r_cd590faa, step 3, entry ent_1a2b3c4d5e6f',
  'the token rotation policy is weekly',
  'password reset emails are slow',
  'https://example.com/docs?page=2',
  'skills: sk-learning is a tag, not a key',
]

describe('redaction', () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`removes a ${name} credential`, () => {
      const r = redact(`config: use ${secret} for the call`)
      assert.ok(!r.text.includes(secret), r.text)
      assert.ok(r.text.includes(SECRET_MARK))
      assert.equal(r.redactions, 1)
    })
  }

  it('removes a private key block, even without its end line', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
    assert.equal(redact(`key:\n${pem}\nthanks`).text, `key:\n${SECRET_MARK}\nthanks`)
    assert.ok(!redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow').text.includes('MIIEow'))
  })

  it('keeps the address and drops the password in user:password@', () => {
    const r = redact('db at postgres://brain:hunter2secret@db.local:5432/brain')
    assert.equal(r.text, `db at postgres://brain:${SECRET_MARK}@db.local:5432/brain`)
  })

  it('drops the value of an authorization header and of key = value assignments', () => {
    assert.equal(
      redact('Authorization: Bearer abcdefgh12345678').text,
      `Authorization: Bearer ${SECRET_MARK}`,
    )
    assert.equal(redact('API_KEY="abcd1234efgh5678"').text, `API_KEY=${SECRET_MARK}`)
    assert.equal(redact('password: correcthorsebattery').text, `password: ${SECRET_MARK}`)
  })

  for (const text of MUST_SURVIVE) {
    it(`leaves ordinary text alone: ${text.slice(0, 40)}`, () => {
      assert.deepEqual(redact(text), { text, redactions: 0 })
    })
  }

  it('CA6: removes <private> blocks, any case, several of them', () => {
    const r = redact('a <private>my address</private> b <PRIVATE>phone 600</PRIVATE> c')
    assert.equal(r.text, `a ${PRIVATE_MARK} b ${PRIVATE_MARK} c`)
    assert.equal(r.redactions, 2)
  })

  it('an unclosed <private> hides everything after it', () => {
    assert.equal(redact('keep <private>secret plans').text, `keep ${PRIVATE_MARK}`)
  })

  it('redacts lists and fields together and adds the counts', () => {
    const r = redactAll({ a: `x ${SECRETS.github}`, b: [SECRETS.aws as string, 'ok'], c: null })
    assert.equal(r.redactions, 2)
    assert.deepEqual(r.fields, { a: `x ${SECRET_MARK}`, b: [SECRET_MARK, 'ok'], c: null })
  })

  it('normalises case and spacing for comparisons', () => {
    assert.equal(normalize('  Intros   of 30s\nWORK  '), 'intros of 30s work')
  })

  it('catches the shapes the review found missing', () => {
    const cases: [string, string][] = [
      ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----', SECRET_MARK],
      ['redis://:s3cretPassw0rdXYZ@cache:6379', `redis://:${SECRET_MARK}@cache:6379`],
      ['{"Authorization": "Bearer abcdefghijklmnop123"}', `{"Authorization": "Bearer ${SECRET_MARK}"}`],
      ['{"password": "hunter2hunter2"}', `{"password": ${SECRET_MARK}}`],
      ['DB_PASSWORD=hunter2hunter2', `DB_PASSWORD=${SECRET_MARK}`],
    ]
    for (const [input, expected] of cases) assert.equal(redact(input).text, expected, input)
    assert.equal(redact('a <private note="x">hidden</private> b').text, `a ${PRIVATE_MARK} b`)
  })

  it('no rule takes long on a hostile 32 000-character text', () => {
    const hostile = [
      'eyJ-'.repeat(8000),
      'a.'.repeat(16000),
      'sk-'.repeat(10666),
      'x://'.repeat(8000),
      'password'.repeat(4000),
      `${'a'.repeat(31990)}:`,
      'Authorization: Bearer '.repeat(1454),
      '-----BEGIN RSA PRIVATE KEY-----'.repeat(1032),
    ]
    // A quadratic rule takes seconds on 32 000 characters; a linear one, a few ms. The margin absorbs
    // slow CI runners and the first, unoptimised run.
    redact('warm up '.repeat(100))
    for (const text of hostile) {
      const t0 = performance.now()
      redact(text)
      const ms = performance.now() - t0
      assert.ok(ms < 500, `${text.slice(0, 12)}… took ${ms.toFixed(0)} ms`)
    }
  })
})
