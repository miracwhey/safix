/**
 * Spatial Lane 3 V1.6 Block 3 · Customer-visible scans workflow
 *
 * Wraps `repo.listCustomerVisibleScans` with an auth check. Throws
 * `not_authenticated` for anonymous callers — the caller (the
 * `useCustomerSpatialScans` hook) maps this to a hydrated empty state.
 *
 * Intentionally NOT re-exported from `lib/spatial/workflow/index.ts` —
 * customer-side modules must not transitively pull `session.ts` via the
 * spatial workflow barrel (see `feedback_spatial_barrel_no_session_imports`).
 */

import { supabase } from '../../supabase'
import { getSpatialRepository } from '../repository/registry'
import type { Scan } from '../types'

export class NotAuthenticatedError extends Error {
  constructor() {
    super('not_authenticated')
    this.name = 'NotAuthenticatedError'
  }
}

export async function listCustomerScans(): Promise<Scan[]> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError) throw authError
  if (!user) throw new NotAuthenticatedError()
  const repo = getSpatialRepository()
  return repo.listCustomerVisibleScans(user.id)
}
