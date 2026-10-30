// Stale-while-revalidate for a screen: what a resource already holds shows at once, and the screen asks
// for it again when it mounts, since it may have changed while the person was elsewhere in the web. A
// resource made by this mount is not asked twice, even when its first answer came back before the screen
// looked (it would count as a second read of a page).
import { useEffect } from 'preact/hooks'
import { type Resource, wantsFresh } from './resource.ts'

export function useFresh(r: Resource<unknown>): void {
  useEffect(() => {
    if (wantsFresh(r)) void r.reload()
  }, [r.key])
}
