import { useEffect, useState } from 'react'
import { isRecovering, subscribeToRecoveryStatus } from '../lib/persistence'

/**
 * React hook reflecting the global resume-recovery flag.
 *
 * Returns true while at least one recovery cycle (resyncRepositories +
 * flushPendingMutations triggered by visibilitychange / fixup:app-resume /
 * online) is active.  Callers — primarily `SyncStatusBar` — use this to
 * suppress transient failure banners that would otherwise flash during the
 * resume → flush → resync window on iOS.
 */
export function useRecoveryStatus(): boolean {
  const [recovering, setRecovering] = useState<boolean>(() => isRecovering())
  useEffect(() => {
    const update = () => setRecovering(isRecovering())
    update()
    return subscribeToRecoveryStatus(update)
  }, [])
  return recovering
}
