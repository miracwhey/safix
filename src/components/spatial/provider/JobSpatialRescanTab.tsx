/**
 * JobSpatialRescanTab — Job-Spatial-Detail · Tab "Re-Scan" (Mockup 24 · B-6 →
 * Phase C · C-7).
 *
 * Phase C (C-7): re-scan requests are persisted to `spatial_rescan_requests`
 * via `useRescanRequests` — the Phase-B in-memory state is gone. The history
 * loads from the repository and updates over realtime, so the customer's
 * accept / reject response appears here without a manual refresh. The submit
 * CTA carries an in-flight guard and is disabled while an open request exists
 * (max one pending request per scene).
 */

import { useCallback, useMemo, useState } from 'react'
import { ScanLine, RotateCcw, CheckCircle2, Clock, XCircle } from 'lucide-react'
import type { JobSpatialTabProps } from './jobSpatialTabs'
import Spinner from '../../system/Spinner'
import type {
  RescanRequestStatus,
  SpatialRescanRequest,
  SpatialScene,
} from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import { useRescanRequests } from '../../../lib/spatial/canonical/workflow/useRescanRequests'
import { useSpatialProviderRole } from '../../../lib/spatial/canonical/workflow/useSpatialProviderRole'
import { useSession } from '../../../hooks/useSession'
import BottomSheet from '../../ui/BottomSheet'
import { useHaptics } from '../../../hooks/useHaptics'

// ─── Reason options (Mockup 24 + spec §6.5) ──────────────────────────────────

const RESCAN_REASONS = [
  'Wand fehlt im Scan',
  'Maß-Drift zu groß',
  'Beleuchtung zu dunkel',
  'Ecke fehlt im Scan',
  'Scan zu unscharf',
  'Sonstiger Grund',
] as const

type RescanReason = (typeof RESCAN_REASONS)[number]

// ─── Status display helpers ───────────────────────────────────────────────────

function statusLabel(status: RescanRequestStatus): string {
  if (status === 'accepted') return 'Zugesagt'
  if (status === 'pending') return 'Offen'
  return 'Abgelehnt'
}

function StatusChip({ status }: { status: RescanRequestStatus }) {
  const base = 'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.3px]'
  if (status === 'accepted')
    return <span className={`${base} bg-[#D1FAE5] text-ok`}>{statusLabel(status)}</span>
  if (status === 'pending')
    return <span className={`${base} bg-[#FEF3C7] text-warn`}>{statusLabel(status)}</span>
  return <span className={`${base} bg-[#FEE2E2] text-danger`}>{statusLabel(status)}</span>
}

function StatusDot({ status }: { status: RescanRequestStatus }) {
  const base = 'flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[9px]'
  if (status === 'accepted')
    return (
      <span className={`${base} bg-[#D1FAE5] text-ok`}>
        <CheckCircle2 size={15} />
      </span>
    )
  if (status === 'pending')
    return (
      <span className={`${base} bg-[#FEF3C7] text-warn`}>
        <Clock size={15} />
      </span>
    )
  return (
    <span className={`${base} bg-[#FEE2E2] text-danger`}>
      <XCircle size={15} />
    </span>
  )
}

// ─── Relative time ────────────────────────────────────────────────────────────

function relTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 2) return 'gerade eben'
  if (m < 60) return `vor ${m} Min`
  const h = Math.floor(m / 60)
  if (h < 24) return `vor ${h} Std`
  const d = Math.floor(h / 24)
  return d === 1 ? 'gestern' : `vor ${d} Tagen`
}

// ─── Scene card ───────────────────────────────────────────────────────────────

function SceneCard({ scene }: { scene: SpatialScene }) {
  return (
    <div className="rounded-card border border-edge bg-surface p-3 shadow-subtle">
      <div className="flex items-center gap-3">
        <div className="flex h-[58px] w-[58px] flex-shrink-0 items-center justify-center rounded-[11px] border border-edge bg-gradient-to-br from-[#EEF1F6] to-[#DDE3EE] text-brand">
          <ScanLine size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-ink">Aufmaß v{scene.schemaVersion}</p>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            LiDAR-Scan · {relTime(scene.createdAt)}
          </p>
          <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[#D1FAE5] px-2 py-0.5 text-[10px] font-bold text-ok">
            <CheckCircle2 size={9} />
            Aktiv für dieses Angebot
          </span>
        </div>
      </div>

      <div className="mt-3 flex gap-4 border-t border-[#ECEFF4] pt-3">
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.3px] text-ink-muted">
            Qualität
          </p>
          <p className="mt-0.5 text-[12.5px] font-[650] text-ink">
            {scene.validationState === 'passed' ||
            scene.validationState === 'passed_with_warnings'
              ? 'Gut'
              : 'Prüfend'}
          </p>
        </div>
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.3px] text-ink-muted">
            Hinweise
          </p>
          <p className="mt-0.5 text-[12.5px] font-[650] text-ink">
            {scene.requiresUserConfirmation ? '1 Warnung' : '0 Warnungen'}
          </p>
        </div>
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.3px] text-ink-muted">
            Schema
          </p>
          <p className="mt-0.5 text-[12.5px] font-[650] text-ink">v{scene.schemaVersion}</p>
        </div>
      </div>
    </div>
  )
}

// ─── Reason-picker sheet ──────────────────────────────────────────────────────

interface ReasonPickerSheetProps {
  submitting: boolean
  /** Last create-write failure, surfaced inline so the sheet stays open. */
  error: string | null
  onSubmit: (reason: string) => void
}

function ReasonPickerSheet({ submitting, error, onSubmit }: ReasonPickerSheetProps) {
  const [selected, setSelected] = useState<RescanReason | null>(null)
  const [customReason, setCustomReason] = useState('')
  const haptics = useHaptics()

  const effectiveReason = useMemo((): string => {
    if (selected === 'Sonstiger Grund') return customReason.trim()
    return selected ?? ''
  }, [selected, customReason])

  const canSubmit = effectiveReason.length > 0 && !submitting

  return (
    <div className="flex flex-col gap-0">
      <p className="mb-3 text-[12.5px] text-ink-sub">
        Du wählst einen Grund — die Kundin bekommt eine Benachrichtigung mit dem
        markierten Problem.
      </p>

      <div className="flex flex-wrap gap-2 pb-1">
        {RESCAN_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            onClick={() => {
              haptics.trigger('selection')
              setSelected(reason)
            }}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-[600] transition-colors ${
              selected === reason
                ? 'border-brand bg-brand text-white'
                : 'border-edge bg-surface text-ink-sub'
            }`}
          >
            {reason}
          </button>
        ))}
      </div>

      {selected === 'Sonstiger Grund' && (
        <textarea
          value={customReason}
          onChange={(e) => setCustomReason(e.target.value)}
          placeholder="Grund beschreiben …"
          rows={3}
          className="mt-3 w-full resize-none rounded-card border border-edge bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
      )}

      {error && (
        <p className="mt-3 rounded-card border border-[#F3C9C9] bg-[#FDF2F2] px-3 py-2 text-[11.5px] font-[600] text-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          if (!canSubmit) return
          haptics.trigger('medium')
          onSubmit(effectiveReason)
        }}
        disabled={!canSubmit}
        className={`mt-4 flex w-full items-center justify-center gap-2 rounded-[12px] py-3.5 text-[13.5px] font-bold transition-opacity ${
          canSubmit
            ? 'bg-brand text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.5)]'
            : 'cursor-not-allowed bg-brand/40 text-white/60'
        }`}
      >
        <RotateCcw size={15} />
        {submitting ? 'Wird gesendet …' : 'Re-Scan anfragen senden'}
      </button>
    </div>
  )
}

// ─── History list ─────────────────────────────────────────────────────────────

function HistoryList({ requests }: { requests: SpatialRescanRequest[] }) {
  if (requests.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-ink-muted">
        Noch keine Re-Scan-Anfragen für diesen Job.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-card border border-edge bg-surface shadow-subtle">
      {requests.map((req) => (
        <div
          key={req.id}
          className="flex items-center gap-3 border-b border-[#ECEFF4] px-3 py-3 last:border-b-0"
        >
          <StatusDot status={req.status} />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-[600] text-ink">Grund: {req.reason}</p>
            <p className="mt-0.5 text-[10.5px] text-ink-muted">
              {req.requestedByRole === 'owner' ? 'Von dir' : 'Vom Team'} ·{' '}
              {relTime(req.createdAt)}
            </p>
            {req.status !== 'pending' && (
              <p
                className={`mt-1 text-[10.5px] font-[600] ${
                  req.status === 'accepted' ? 'text-ok' : 'text-danger'
                }`}
              >
                {req.status === 'accepted'
                  ? req.resultingSceneId
                    ? 'Kundin hat neu gescannt'
                    : 'Kundin hat zugesagt'
                  : 'Kundin hat abgelehnt'}
                {req.responseNote ? ` — „${req.responseNote}"` : ''}
                {req.respondedAt ? ` · ${relTime(req.respondedAt)}` : ''}
              </p>
            )}
            {req.status === 'accepted' && req.resultingSceneId && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#D1FAE5] px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.3px] text-ok">
                <ScanLine size={9} />
                Neues Aufmaß da
              </span>
            )}
          </div>
          <StatusChip status={req.status} />
        </div>
      ))}
    </div>
  )
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function JobSpatialRescanTab({ scene }: JobSpatialTabProps) {
  const [showReasonPicker, setShowReasonPicker] = useState(false)
  const haptics = useHaptics()
  const session = useSession()
  const { role } = useSpatialProviderRole()
  const { requests, loading, submitting, error, hasPending, create } =
    useRescanRequests(scene.id)

  const requestedByRole: 'owner' | 'worker' | null =
    role === 'owner' ? 'owner' : role === 'worker' ? 'worker' : null
  const userId = session.user?.id ?? null
  const canRequest =
    requestedByRole !== null && userId !== null && scene.providerOrgId !== null

  const handleRequestSubmit = useCallback(
    async (reason: string) => {
      if (!canRequest || requestedByRole === null || userId === null || scene.providerOrgId === null) {
        return
      }
      const persisted = await create({
        sceneId: scene.id,
        providerOrgId: scene.providerOrgId,
        requestedByUserId: userId,
        requestedByRole,
        reason,
      })
      if (!persisted) {
        // `create` already surfaced the reason via `error` — keep the sheet
        // open so the user can retry.
        haptics.trigger('error')
        return
      }
      haptics.trigger('success')
      setShowReasonPicker(false)
    },
    [canRequest, requestedByRole, userId, scene.providerOrgId, scene.id, create, haptics],
  )

  const ctaDisabled = !canRequest || hasPending || submitting

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* Section: Aktuelle Aufnahme */}
        <p className="mb-2 mt-3 text-[12px] font-bold uppercase tracking-[0.6px] text-ink-sub">
          Aktuelle Aufnahme
        </p>
        <SceneCard scene={scene} />

        {/* CTA */}
        <button
          type="button"
          onClick={() => {
            if (ctaDisabled) return
            haptics.trigger('medium')
            setShowReasonPicker(true)
          }}
          disabled={ctaDisabled}
          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-[12px] py-3.5 text-[13.5px] font-bold transition ${
            ctaDisabled
              ? 'cursor-not-allowed border border-edge bg-[#F4F5F8] text-ink-muted'
              : 'bg-brand text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.5)]'
          }`}
        >
          <RotateCcw size={16} />
          {hasPending ? 'Anfrage läuft bereits' : 'Erneuten Scan anfragen'}
        </button>
        <p className="mt-2 text-center text-[11px] leading-snug text-ink-muted">
          {!canRequest
            ? 'Nur das Team kann einen Re-Scan anfragen.'
            : hasPending
              ? 'Es läuft bereits eine Anfrage — warte die Antwort der Kundin ab.'
              : 'Du wählst einen Grund — die Kundin bekommt eine Benachrichtigung mit dem markierten Problem-Pin.'}
        </p>

        {/* Section: Verlauf */}
        <p className="mb-2 mt-5 text-[12px] font-bold uppercase tracking-[0.6px] text-ink-sub">
          Verlauf
        </p>
        {loading ? (
          <div className="flex h-[72px] items-center justify-center rounded-card border border-edge bg-canvas">
            <Spinner size="md" tone="brand" />
          </div>
        ) : (
          <HistoryList requests={requests} />
        )}
      </div>

      {/* Reason-picker sheet */}
      <BottomSheet
        open={showReasonPicker}
        onClose={() => setShowReasonPicker(false)}
        title="Re-Scan anfragen"
        description="Wähle den Grund für den erneuten Scan."
        maxWidth={480}
      >
        <div className="mt-3">
          <ReasonPickerSheet
            submitting={submitting}
            error={error}
            onSubmit={handleRequestSubmit}
          />
        </div>
      </BottomSheet>
    </div>
  )
}
