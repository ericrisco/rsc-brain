// «Create brain» (spec B6 Home; B1 «Cerebros»): a name, the address that follows it until the person
// edits it, and what the brain is for. The creator becomes its curator and lands on its overview, where
// the first steps start. A taken or wrong address is said next to the address, with the keyboard there;
// what was typed stays.
import { useEffect, useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { invalidate } from '../api/resource.ts'
import { slugOf } from '../lib/brains.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Field } from '../ui/Field.tsx'
import { writeBlocked } from '../ui/state.ts'
import { FormAlert } from '../ui/states.tsx'
import { createOpen } from './dialogs.ts'

type Problems = { name?: string | undefined; slug?: string | undefined; purpose?: string | undefined }
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

function focus(name: keyof Problems) {
  const el = document.querySelector<HTMLInputElement>(`dialog [name="${name}"]`)
  el?.focus()
}

function Form() {
  const { route } = useLocation()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [edited, setEdited] = useState(false)
  const [purpose, setPurpose] = useState('')
  const [problems, setProblems] = useState<Problems>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => focus('name'), [])

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pending || !online.value) return
    setError(null)
    const n = T.create.need
    const p: Problems = {}
    if (!name.trim()) p.name = n.name
    else if (name.trim().length > 80) p.name = n.nameLong
    if (!SLUG.test(slug) || slug.length < 2 || slug.length > 64) p.slug = n.slug
    if (purpose.length > 1000) p.purpose = n.purposeLong
    setProblems(p)
    const first = (['name', 'slug', 'purpose'] as const).find((k) => p[k])
    if (first) return focus(first)
    setPending(true)
    try {
      await api.call('createBrain', { body: { slug, name: name.trim(), purpose: purpose.trim() } })
      invalidate('brains')
      createOpen.value = false
      route(`/b/${encodeURIComponent(slug)}`)
    } catch (err) {
      const a = err as ApiError
      if (a.code === 'brain_exists' || (a.status === 400 && /slug|brain name/i.test(a.message))) {
        setProblems({ slug: `${a.message} ${a.howToProceed}` })
        focus('slug')
      } else setError(a)
    } finally {
      setPending(false)
    }
  }
  const blocked = writeBlocked({ online: online.value, pending: false })
  return (
    <form class="form" onSubmit={submit} noValidate>
      <FormAlert error={error} />
      <Field
        label={T.create.name}
        hint={T.create.nameHint}
        name="name"
        autocomplete="off"
        maxLength={80}
        value={name}
        problem={problems.name}
        onValue={(v) => {
          setName(v)
          if (!edited) setSlug(slugOf(v))
          if (problems.name) setProblems({ ...problems, name: undefined })
        }}
      />
      <Field
        label={T.create.slug}
        hint={T.create.slugHint}
        name="slug"
        class="mono"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        maxLength={64}
        value={slug}
        problem={problems.slug}
        onValue={(v) => {
          setSlug(v.toLowerCase())
          setEdited(true)
          if (problems.slug) setProblems({ ...problems, slug: undefined })
        }}
      />
      {/* One line: Enter creates the brain, as in the other fields (the hint asks for one sentence). */}
      <Field
        label={T.create.purpose}
        hint={T.create.purposeHint}
        name="purpose"
        maxLength={1000}
        value={purpose}
        problem={problems.purpose}
        onValue={setPurpose}
      />
      <div class="actions">
        <Button
          type="submit"
          kind="primary"
          pending={pending}
          pendingLabel={T.create.submitting}
          blocked={blocked}
        >
          {T.create.submit}
        </Button>
        <Button kind="quiet" onClick={() => (createOpen.value = false)}>
          {T.create.cancel}
        </Button>
      </div>
    </form>
  )
}

export function CreateBrainDialog() {
  return (
    <Dialog
      open={createOpen.value}
      title={T.create.title}
      onClose={() => (createOpen.value = false)}
      closeLabel={T.help.close}
    >
      {createOpen.value ? <Form /> : null}
    </Dialog>
  )
}
