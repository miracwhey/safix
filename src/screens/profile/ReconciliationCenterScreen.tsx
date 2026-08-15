/**
 * `ReconciliationCenterScreen` — profile-side list of the user's dispute
 * cases. Mounts the reactive list buckets and the presentational
 * `ReconciliationList`.
 *
 * Role-parametrised so the same screen serves both the craftsman surface
 * (`/craftsman/profile/disputes`) and the customer surface
 * (`/customer/profile/disputes`). The role only changes:
 *   - the back-link target
 *   - the `requiresAction` classification inside the list selector
 *     (customer_waiting vs provider_waiting)
 *   - the per-item detail link prefix
 *   - the DSGVO Art. 15 export `role` field
 *
 * Disputes themselves are filtered at the data layer (RLS + repository),
 * so the hook receives only the viewer's own disputes regardless of role.
 */

import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Download } from 'lucide-react'
import AppShell from '../../components/AppShell'
import ScreenHeader from '../../components/primitives/ScreenHeader'
import { ReconciliationList } from '../reconciliation/ReconciliationList'
import { useReconciliationListBuckets } from '../../lib/reconciliation/useReconciliationListBuckets'
import { useSession } from '../../hooks/useSession'
import {
  allDisputesExportFilename,
  buildAllDisputesExportPayload,
  serialiseAllDisputesExport,
  triggerJsonDownload,
} from '../../lib/reconciliation/export'
import type { ReconciliationRole } from '../../lib/reconciliation'

type Props = {
  role: ReconciliationRole
}

const ROUTE_PREFIX_BY_ROLE: Record<ReconciliationRole, string> = {
  craftsman: '/craftsman/profile/disputes',
  customer: '/customer/profile/disputes',
}

const PROFILE_BACK_BY_ROLE: Record<ReconciliationRole, string> = {
  craftsman: '/craftsman/profile',
  customer: '/profile',
}

export default function ReconciliationCenterScreen({ role }: Props) {
  const navigate = useNavigate()
  const session = useSession()
  const buckets = useReconciliationListBuckets(role)
  const total = buckets.counts.active + buckets.counts.resolved
  const detailRoutePrefix = ROUTE_PREFIX_BY_ROLE[role]
  const backTo = PROFILE_BACK_BY_ROLE[role]
  const viewerUserId = session.user?.id ?? ''

  function handleExport() {
    if (!viewerUserId) return
    const payload = buildAllDisputesExportPayload({
      buckets,
      viewerUserId,
      role,
    })
    triggerJsonDownload(allDisputesExportFilename(payload), serialiseAllDisputesExport(payload))
  }

  return (
    <AppShell active="profile">
      <div className="bg-canvas min-h-full">
        <header className="px-4 pt-3 pb-4 border-b border-edge bg-canvas">
          <button
            type="button"
            onClick={() => navigate(backTo)}
            className="inline-flex items-center gap-1 text-[14px] font-medium text-brand mb-3"
          >
            <ChevronLeft className="w-5 h-5" strokeWidth={2.2} />
            Profil
          </button>
          <ScreenHeader
            eyebrow={`Übersicht · ${total} ${total === 1 ? 'Verfahren' : 'Verfahren'}`}
            title="Klärungscenter"
          />
          <p className="mt-2 text-[13.5px] text-ink-sub leading-snug">
            Alles, was zwischen dir und {role === 'customer' ? 'einem Anbieter' : 'einem Kunden'} zu klären ist — der
            seltene Fall.
          </p>
          {total > 0 ? (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-muted">
              <span>
                <b className="text-ink font-bold tabular-nums">{buckets.counts.active}</b>{' '}
                aktiv
              </span>
              {buckets.counts.awaitingViewer > 0 ? (
                <span>
                  <b className="text-danger font-bold tabular-nums">
                    {buckets.counts.awaitingViewer}
                  </b>{' '}
                  warten auf dich
                </span>
              ) : null}
              <span>
                <b className="text-ink font-bold tabular-nums">{buckets.counts.resolved}</b>{' '}
                abgeschlossen
              </span>
            </div>
          ) : null}
        </header>

        <main className="pt-4">
          <ReconciliationList
            buckets={buckets}
            detailRoutePrefix={detailRoutePrefix}
          />
          {total > 0 ? (
            <div className="px-4 pt-2 pb-4 flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleExport}
                disabled={!viewerUserId}
                className="inline-flex items-center gap-2 rounded-container border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-ink-sub shadow-subtle disabled:opacity-50"
              >
                <Download className="h-4 w-4" strokeWidth={2.2} />
                Daten exportieren (JSON)
              </button>
              <p className="text-[11px] tracking-[.04em] text-ink-muted text-center">
                DSGVO Art. 15 · Auskunftsrecht
              </p>
            </div>
          ) : null}
        </main>
      </div>
    </AppShell>
  )
}
