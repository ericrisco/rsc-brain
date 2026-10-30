// A password field with a "Show" button, so a person can check what they typed (ux: every password
// field). The button says whether the password is shown (aria-pressed).
import type { ComponentProps } from 'preact'
import { useState } from 'preact/hooks'
import { T } from '../text.ts'
import { Field } from './Field.tsx'

export function PasswordField(props: Omit<ComponentProps<typeof Field>, 'type' | 'after'>) {
  const [show, setShow] = useState(false)
  return (
    <Field
      {...props}
      type={show ? 'text' : 'password'}
      autocapitalize="off"
      spellcheck={false}
      after={
        <button
          type="button"
          class="button quiet"
          aria-pressed={show ? 'true' : 'false'}
          onClick={() => setShow(!show)}
        >
          {show ? T.setup.hide : T.setup.show}
        </button>
      }
    />
  )
}
