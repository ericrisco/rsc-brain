// Stale-while-revalidate for a screen: what a resource already holds shows at once, and the screen asks
// for it again when it mounts, since it may have changed while the person was elsewhere in the web. A
// resource made by this mount is already loading and is not asked twice.
import { useEffect } from 'preact/hooks'
import type { Resource } from './resource.ts'

export function useFresh(r: Resource<unknown>): void {
  useEffect(() => {
    if (!r.loading.value) void r.reload()
  }, [r.key])
}
