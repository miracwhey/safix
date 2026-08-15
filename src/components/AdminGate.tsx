import type { ReactNode } from 'react'
import { useSession } from '../hooks/useSession'
import { canAccessDisputeResolution } from '../lib/access'

type Props = { children: ReactNode }

/**
 * Renders children only when the session belongs to a craftsman owner with
 * the operator flag set (profiles.is_operator = true).
 * Use this to wrap internal operational controls that must not be visible to
 * normal craftsman or customer product users.
 */
export default function AdminGate({ children }: Props) {
  const session = useSession()
  if (!canAccessDisputeResolution(session)) return null
  return <>{children}</>
}
