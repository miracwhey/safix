import { useEffect, useState } from 'react'
import { getSession, subscribeSession, type SessionState } from '../lib/session'

/**
 * React hook that subscribes to the shared reactive session.
 * Returns the current `SessionState` and re-renders on every change.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<SessionState>(getSession)

  useEffect(() => {
    return subscribeSession(() => {
      setSession(getSession())
    })
  }, [])

  return session
}
