// "?" — the list of shortcuts, each with the visible control that does the same (CA20).
import { SHORTCUTS } from '../lib/shortcuts.ts'
import { localizeMessage, T } from '../text.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { helpOpen } from './keys.ts'

export function HelpDialog({
  signedIn,
  inBrain,
  canInvite = false,
}: {
  signedIn: boolean
  inBrain: boolean
  canInvite?: boolean
}) {
  const shown = SHORTCUTS.filter(
    (s) => (s.id === 'help' || signedIn) && (!s.inBrain || inBrain) && (!s.invite || canInvite),
  )
  return (
    <Dialog open={helpOpen.value} title={T.help.title} onClose={() => (helpOpen.value = false)}>
      <p class="muted">{T.help.lead}</p>
      <table class="shortcut-table" data-testid="shortcuts">
        <thead>
          <tr>
            <th scope="col">{T.help.key}</th>
            <th scope="col">{T.help.does}</th>
            <th scope="col">{T.help.control}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.id} data-shortcut={s.id}>
              <td>
                {s.id.startsWith('go-') ? (
                  <>
                    <kbd>{s.keys[0]}</kbd> {T.help.nextKey} <kbd>{s.keys[1]}</kbd>
                  </>
                ) : (
                  s.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 ? ` ${T.help.or} ` : ''}
                      <kbd>{k}</kbd>
                    </span>
                  ))
                )}
              </td>
              <td>{localizeMessage(s.label)}</td>
              <td class="muted">{localizeMessage(s.control)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  )
}
