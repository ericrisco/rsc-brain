// The frame of the screens before a session: sign in, first run, invitation, reset. The installation's
// name and logo on top, one panel in the middle. `brand={false}`: the logo is not a link (the first-time
// setup, where there is nowhere else to go). `signedIn`: the logo leads home, not to sign in.
import type { ComponentChildren } from 'preact'
import { T } from '../text.ts'
import { Brand } from '../ui/Brand.tsx'
import { OfflineStrip } from '../ui/states.tsx'
import { HelpDialog } from './HelpDialog.tsx'
import { Keyboard } from './Keyboard.tsx'
import { helpOpen } from './keys.ts'

export function Door({
  children,
  wide,
  brand = true,
  signedIn = false,
}: {
  children: ComponentChildren
  wide?: boolean
  brand?: boolean
  signedIn?: boolean
}) {
  return (
    <div class="door">
      <header class="topbar">
        <Brand href={brand ? (signedIn ? '/' : '/sign-in') : null} />
      </header>
      <main id="main">
        <OfflineStrip />
        <div class={`panel${wide ? ' wide' : ''}`}>{children}</div>
      </main>
      <footer>
        <span>{T.product}</span>
        <button type="button" class="linkish keyboard-only" onClick={() => (helpOpen.value = true)}>
          {T.shell.shortcuts}
        </button>
      </footer>
      <Keyboard signedIn={false} brain={null} />
      <HelpDialog signedIn={false} inBrain={false} />
    </div>
  )
}
