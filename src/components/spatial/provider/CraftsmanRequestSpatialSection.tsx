/**
 * Spatial · CAD Lane V1.5.1 Phase B · CraftsmanRequestSpatialSection
 *
 * Pre-Job HW-Sicht auf Customer-Direct-Shared Aufmaße. Rendered inside
 * `CraftsmanRequestDetailScreen` directly under `RequestDetailView` —
 * gives the HW a lead-conversion preview of the Customer's 3D scan
 * BEFORE accepting the Anfrage and triggering job-creation.
 *
 * Visibility chain:
 *   1. Customer makes a Self-Scan (`owner_type='customer'`).
 *   2. Customer shares directly via {@link SpatialShareSheet} HW-picker →
 *      `scans.shared_with_provider_id` set (M1 migration 20260525234500).
 *   3. RLS `spatial_can_view_scan` includes the `shared_with_provider_id`
 *      clause — HW (auth.uid()) can read the row.
 *   4. This section queries scans where the share target equals the current
 *      HW user AND `captured_by` matches the Anfrage's customer.
 *
 * Renders nothing while loading and when no matching scans exist — keeps
 * the request detail screen visually quiet for the common case.
 *
 * Tap on a card navigates to `/craftsman/spatial/scan/:scanId` if such a
 * route exists, otherwise the section stays read-only with a thumbnail +
 * meta line. V1.5.1 ships without an explicit HW-side scan viewer — the
 * post-job pathway via `CraftsmanJobDetailScreen` covers the full surface.
 */

import { useEffect, useRef, useState } from 'react'
import { Box, Eye } from 'lucide-react'

import { supabase } from '../../../lib/supabase'
import { getSpatialRepository } from '../../../lib/spatial/repository/registry'
import type { Scan } from '../../../lib/spatial/types'

export interface CraftsmanRequestSpatialSectionProps {
  /** The Anfrage's owner — used to scope which direct-shared scans count
   *  as relevant to this request. */
  customerUserId: string | null | undefined
}

export default function CraftsmanRequestSpatialSection({
  customerUserId,
}: CraftsmanRequestSpatialSectionProps) {
  const [scans, setScans] = useState<Scan[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    void (async () => {
      // Push the no-customer reset off the synchronous effect tick so
      // `react-hooks/set-state-in-effect` stays happy; the initial paint
      // already sits at empty + not-hydrated.
      await Promise.resolve()
      if (!aliveRef.current) return
      if (!customerUserId) {
        setScans([])
        setIsHydrated(true)
        return
      }
      try {
        const { data: authUser } = await supabase.auth.getUser()
        const uid = authUser.user?.id
        if (!uid) {
          if (aliveRef.current) {
            setScans([])
            setIsHydrated(true)
          }
          return
        }
        // RLS already filters to rows the HW may see; the explicit
        // `captured_by` filter scopes to this Anfrage's customer so we
        // don't surface unrelated direct-shares on this screen.
        const safeUid = uid.replace(/[(),\s'"]/g, '')
        const safeCustomer = customerUserId.replace(/[(),\s'"]/g, '')
        const { data } = await supabase
          .from('scans')
          .select()
          .eq('shared_with_provider_id', safeUid)
          .eq('captured_by', safeCustomer)
          .eq('owner_type', 'customer')
          .order('created_at', { ascending: false })
        if (!aliveRef.current) return
        const rows = (data ?? []) as unknown[]
        const repo = getSpatialRepository()
        // Convert via the canonical mapper — fall back to a per-row repo
        // fetch when the inline cast doesn't have all required fields.
        const mapped: Scan[] = []
        for (const r of rows) {
          if (typeof r === 'object' && r !== null && 'id' in r) {
            const fresh = await repo.getScan((r as { id: string }).id)
            if (fresh) mapped.push(fresh)
          }
        }
        if (aliveRef.current) {
          setScans(mapped)
          setIsHydrated(true)
        }
      } catch {
        if (aliveRef.current) {
          setScans([])
          setIsHydrated(true)
        }
      }
    })()
    return () => {
      aliveRef.current = false
    }
  }, [customerUserId])

  if (!isHydrated || scans.length === 0) return null

  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/10 text-brand">
            <Box size={15} aria-hidden />
          </span>
          <h3 className="text-[14px] font-bold text-ink">Kunde hat dir Aufmaß freigegeben</h3>
        </div>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          NEU
        </span>
      </div>
      <p className="mt-2 text-[12px] text-ink-muted">
        Der Kunde hat dir {scans.length} 3D-Aufmaß{scans.length === 1 ? '' : 'e'} direkt
        freigegeben — sichtbar bereits vor der Anfrage-Annahme.
      </p>

      <ul className="mt-3 space-y-2">
        {scans.map(scan => (
          <li
            key={scan.id}
            className="flex items-center gap-3 rounded-card bg-slate-50 px-3 py-2 ring-1 ring-slate-200/60"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white text-brand ring-1 ring-slate-200">
              <Box size={16} aria-hidden />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-ink">Eigenes Kunden-Aufmaß</div>
              <div className="text-[11px] text-ink-muted">{formatDate(scan.createdAt)}</div>
            </div>
            <span className="flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-ink-muted ring-1 ring-slate-200">
              <Eye size={11} aria-hidden /> nur lesen
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(ts))
  } catch {
    return ''
  }
}
