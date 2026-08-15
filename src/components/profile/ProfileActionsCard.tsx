import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signOut, deleteAccount } from '../../lib/auth'
import type { Role } from '../../lib/profile'
import LegalSheet from '../legal/LegalSheet'
import { useReconciliationListBuckets } from '../../lib/reconciliation/useReconciliationListBuckets'
import type { ReconciliationRole } from '../../lib/reconciliation'

type Props = {
  role: Role | null
}

const RECONCILIATION_ROUTE_BY_ROLE: Record<ReconciliationRole, string> = {
  craftsman: '/craftsman/profile/disputes',
  customer: '/customer/profile/disputes',
}

export default function ProfileActionsCard({ role }: Props) {
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [legalSheetOpen, setLegalSheetOpen] = useState(false)

  const handleLogout = async () => {
    try {
      setLogoutError(null)
      await signOut()
      navigate('/login', { replace: true })
    } catch (e: unknown) {
      setLogoutError(
        e instanceof Error ? e.message : 'Abmeldung fehlgeschlagen. Bitte versuche es erneut.'
      )
    }
  }

  const handleDeleteAccount = async () => {
    try {
      setDeleting(true)
      setDeleteError(null)
      await deleteAccount()
      navigate('/login', { replace: true })
    } catch (e: unknown) {
      setDeleteError(
        e instanceof Error ? e.message : 'Konto konnte nicht gelöscht werden.'
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-2">
      {/* Klärungen — surfaced to both craftsman and customer with role-aware routing.
          Reconciliation buckets subscribe disputes/jobs/payments stores; the entry is
          extracted into a sub-component so non-reconciliation roles (operator, worker,
          unauthenticated) don't pay the subscription cost. */}
      {role === 'craftsman' || role === 'customer' ? (
        <ReconciliationEntry role={role} navigate={navigate} />
      ) : null}

      {/* Handwerker-Rolle (owner/worker innerhalb des Betriebs) — die frühere
          „Hauptrolle ändern"-Verknüpfung (customer↔craftsman via /onboarding/role)
          war ein Debug-Shortcut und wurde als Sicherheits-/Konsistenz-Risiko entfernt. */}
      {role === 'craftsman' && (
        <button
          onClick={() => navigate('/onboarding/craftsman-role')}
          className="flex w-full items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 text-left ring-1 ring-slate-200/70 transition active:scale-[0.98]"
        >
          <span className="text-[16px] leading-none">🔧</span>
          <span className="text-[14px] font-semibold text-slate-900">Handwerker-Rolle ändern</span>
          <span className="ml-auto text-[14px] text-slate-400">›</span>
        </button>
      )}

      {/* Legal & Support */}
      <button
        onClick={() => setLegalSheetOpen(true)}
        className="flex w-full items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 text-left ring-1 ring-slate-200/70 transition active:scale-[0.98]"
      >
        <span className="text-[16px] leading-none">📋</span>
        <div className="min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-slate-900">Datenschutz, AGB & Impressum</span>
        </div>
        <span className="ml-auto text-[14px] text-slate-400">›</span>
      </button>

      <a
        href="mailto:team@safix.digital"
        className="flex w-full items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 text-left ring-1 ring-slate-200/70 transition active:scale-[0.98]"
      >
        <span className="text-[16px] leading-none">💬</span>
        <div className="min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-slate-900">Hilfe & Kontakt</span>
          <div className="text-[12px] text-slate-500">team@safix.digital</div>
        </div>
        <span className="ml-auto text-[14px] text-slate-400">›</span>
      </a>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="w-full rounded-[20px] bg-[#0F1740] px-4 py-3.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
      >
        Ausloggen
      </button>

      {logoutError && (
        <p className="text-xs text-red-600 text-center">{logoutError}</p>
      )}

      {/* Account Deletion */}
      {!confirmDelete ? (
        <button
          onClick={() => setConfirmDelete(true)}
          className="w-full rounded-[20px] bg-white px-4 py-3.5 text-left text-[13px] font-medium text-red-500 ring-1 ring-slate-200/70"
        >
          Konto löschen
        </button>
      ) : (
        <div className="rounded-[20px] bg-red-50 p-4 ring-1 ring-red-200">
          <p className="text-[14px] font-semibold text-red-800">
            Konto unwiderruflich löschen?
          </p>
          <p className="mt-1 text-[12px] text-red-600">
            Deine persönlichen Daten, Medien und Scans werden dauerhaft gelöscht.
            Gesetzlich aufbewahrungspflichtige Rechnungen bleiben gespeichert
            (gesperrt), und abgeschlossene Aufträge werden anonymisiert. Solange
            noch abgesicherte Zahlungen oder offene Streitfälle bestehen, ist die
            Löschung nicht möglich.
          </p>

          {deleteError && (
            <p className="mt-2 text-[12px] text-red-700">{deleteError}</p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleDeleteAccount}
              disabled={deleting}
              className="flex-1 rounded-xl bg-red-600 px-3 py-2.5 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {deleting ? 'Lösche...' : 'Endgültig löschen'}
            </button>
            <button
              onClick={() => {
                setConfirmDelete(false)
                setDeleteError(null)
              }}
              disabled={deleting}
              className="flex-1 rounded-xl bg-white px-3 py-2.5 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      <LegalSheet open={legalSheetOpen} onClose={() => setLegalSheetOpen(false)} />
    </div>
  )
}

/**
 * Reconciliation entry — extracted into a sub-component so the
 * `useReconciliationListBuckets` hook (which subscribes disputes / jobs /
 * payments stores) only mounts for roles that actually own the entry. Non-
 * reconciliation roles (operator, worker, unauthenticated) get a quick
 * early-return in the parent and pay nothing for the entry.
 */
function ReconciliationEntry({
  role,
  navigate,
}: {
  role: ReconciliationRole
  navigate: (to: string) => void
}) {
  const reconciliation = useReconciliationListBuckets(role)
  const reconciliationBadge =
    reconciliation.counts.awaitingViewer > 0
      ? reconciliation.counts.awaitingViewer
      : null
  const route = RECONCILIATION_ROUTE_BY_ROLE[role]

  return (
    <button
      onClick={() => navigate(route)}
      className="flex w-full items-center gap-3 rounded-[20px] bg-white px-4 py-3.5 text-left ring-1 ring-slate-200/70 transition active:scale-[0.98]"
    >
      <span className="text-[16px] leading-none">⚖️</span>
      <div className="min-w-0 flex-1">
        <span className="text-[14px] font-semibold text-slate-900">Klärungen</span>
        {reconciliation.counts.active > 0 ? (
          <div className="text-[12px] text-slate-500">
            {reconciliation.counts.active} aktiv
            {reconciliation.counts.awaitingViewer > 0
              ? ` · ${reconciliation.counts.awaitingViewer} warten auf dich`
              : ''}
          </div>
        ) : (
          <div className="text-[12px] text-slate-500">Streitfälle und Verlauf</div>
        )}
      </div>
      {reconciliationBadge !== null ? (
        <span className="ml-2 inline-flex min-w-[20px] items-center justify-center rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white tabular-nums">
          {reconciliationBadge}
        </span>
      ) : null}
      <span className="ml-2 text-[14px] text-slate-400">›</span>
    </button>
  )
}
