// Inviting people (spec B4 «Invitar», B6 «Admin › people»): the emails typed or pasted, and whether an
// administrator is still alone in the installation (Home offers to invite until someone joins).

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

export function emailsOf(text: string): { emails: string[]; bad: string[] } {
  const emails: string[] = []
  const bad: string[] = []
  // "Ana Ruiz <ana@example.com>" pasted from a mail program counts as its email.
  const plain = text.replace(/[^,;\n<>]*<([^<>]+)>/g, ' $1 ')
  for (const raw of plain.split(/[\s,;]+/)) {
    const v = raw.trim()
    if (!v) continue
    const e = v.toLowerCase()
    if (!EMAIL.test(e)) {
      if (!bad.includes(v)) bad.push(v)
    } else if (!emails.includes(e)) emails.push(e)
  }
  return { emails, bad }
}

type Account = { kind: string; status: string }

export function firstPersonAlone(accounts: readonly Account[]): boolean {
  return accounts.filter((a) => a.kind === 'person' && a.status === 'active').length < 2
}
