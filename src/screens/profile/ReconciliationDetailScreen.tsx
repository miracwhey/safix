/**
 * `ReconciliationDetailScreen` — profile-side detail wrapper. Resolves the
 * Aktenzeichen URL slug to the underlying dispute id, then mounts the shared
 * `<ReconciliationDetail>` component in standalone mode.
 *
 * The same detail component is rendered embedded from the job tab in N13.4.
 *
 * Role-parametrised so the same screen serves both
 * `/craftsman/profile/disputes/:akz` and `/customer/profile/disputes/:akz`.
 * Role flows through to the detail component for context-aware copy and
 * back-navigation.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Download } from 'lucide-react'
import AppShell from '../../components/AppShell'
import { ReconciliationDetail } from '../reconciliation/ReconciliationDetail'
import {
  aktenzeichenFromUrlSlug,
  findDisputeByAktenzeichen,
} from '../../lib/reconciliation/aktenzeichen'
import { getDisputes, subscribeDisputes } from '../../lib/disputes/disputeStore'
import { useReconciliationView } from '../../lib/reconciliation/useReconciliationView'
import {
  buildDisputeExportPayload,
  disputeExportFilename,
  serialiseDisputeExport,
  triggerJsonDownload,
} from '../../lib/reconciliation/export'
import type { ReconciliationRole } from '../../lib/reconciliation'

type Props = {
  role: ReconciliationRole
}

const CENTER_ROUTE_BY_ROLE: Record<ReconciliationRole, string> = {
  craftsman: '/craftsman/profile/disputes',
  customer: '/customer/profile/disputes',
}

export default function ReconciliationDetailScreen({ role }: Props) {
  const navigate = useNavigate()
  const { akz: akzSlug } = useParams<{ akz: string }>()
  const akz = akzSlug ? aktenzeichenFromUrlSlug(akzSlug) : null
  const centerRoute = CENTER_ROUTE_BY_ROLE[role]

  // Re-resolve the dispute id whenever the disputes store changes — the
  // dispute may not yet be hydrated on the first render.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const unsub = subscribeDisputes(() => setVersion((v) => v + 1))
    return unsub
  }, [])

  const disputeId = useMemo(() => {
    if (!akz) return null
    const match = findDisputeByAktenzeichen(akz, getDisputes())
    return match?.id ?? null
    // version triggers re-resolution after hydration / mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [akz, version])

  const viewState = useReconciliationView({
    disputeId: disputeId ?? '',
    role,
  })

  function handleExport() {
    if (!viewState.view) return
    const payload = buildDisputeExportPayload(viewState.view)
    triggerJsonDownload(disputeExportFilename(payload), serialiseDisputeExport(payload))
  }

  return (
    <AppShell active="profile">
      <div className="bg-canvas min-h-full">
        <header className="px-4 pt-3 pb-2 bg-canvas flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate(centerRoute)}
            className="inline-flex items-center gap-1 text-[14px] font-medium text-brand"
          >
            <ChevronLeft className="w-5 h-5" strokeWidth={2.2} />
            Klärungen
          </button>
          {viewState.view ? (
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex items-center gap-1 rounded-chip border border-edge bg-surface px-3 py-1 text-[12px] font-semibold text-ink-sub shadow-subtle"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2.2} />
              JSON
            </button>
          ) : null}
        </header>
        {disputeId ? (
          <ReconciliationDetail disputeId={disputeId} role={role} />
        ) : (
          <NotFound akz={akz} onBack={() => navigate(centerRoute)} />
        )}
      </div>
    </AppShell>
  )
}

function NotFound({ akz, onBack }: { akz: string | null; onBack: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h2 className="text-[18px] font-bold text-ink">
        Streitfall nicht gefunden
      </h2>
      <p className="mt-2 max-w-xs text-[13px] text-ink-sub">
        {akz ? (
          <>
            Aktenzeichen <span className="font-mono">{akz}</span> ist diesem
            Konto nicht zugeordnet — möglicherweise wurde der Fall geschlossen
            oder du hast keinen Zugriff darauf.
          </>
        ) : (
          'Aktenzeichen ungültig.'
        )}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-6 rounded-container bg-brand px-4 py-2 text-[14px] font-semibold text-white shadow-elevated"
      >
        Zurück zum Klärungscenter
      </button>
    </div>
  )
}
