/**
 * CustomerSpatialRescanScreen — customer-facing re-scan response
 * (Phase C · C-7 · Seam 6 · loop closure).
 *
 * The customer has no Provider-Hub. When a provider sends a re-scan request
 * (`spatial_rescan_requests`), the customer is push-notified and deep-linked
 * here. This screen shows the request reason and lets the customer accept
 * (commit to re-recording the room) or reject (with a note). The response is
 * written via the SECURITY DEFINER RPC `spatial_rescan_request_respond`,
 * which closes the loop back to the provider's Re-Scan tab.
 *
 * Route: /spatial/rescan/:requestId
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronLeft,
  RotateCcw,
  CheckCircle2,
  XCircle,
  ScanLine,
} from 'lucide-react'
import Spinner from '../components/system/Spinner'
import { getSpatialSceneRepository } from '../lib/spatial/canonical/repository/registry'
import type {
  SpatialRescanRequest,
  SpatialScene,
} from '../lib/spatial/canonical/repository/SpatialSceneRepository'
import { useHaptics } from '../hooks/useHaptics'
import { useStartRoomScan } from '../hooks/useStartRoomScan'
import { useToast } from '../hooks/useToast'
import { useSmartBack } from '../hooks/useSmartBack'

type RespondMode = 'idle' | 'rejecting'

export default function CustomerSpatialRescanScreen() {
  const { requestId } = useParams<{ requestId: string }>()
  const navigate = useNavigate()
  const goBack = useSmartBack('/')
  const haptics = useHaptics()
  const toast = useToast()
  const { startScan, busy: scanBusy } = useStartRoomScan()

  const [request, setRequest] = useState<SpatialRescanRequest | null>(null)
  const [parentScene, setParentScene] = useState<SpatialScene | null>(null)
  // Initial state derives from `requestId` so the missing-id branch never
  // needs to run a setState inside the effect (react-hooks/set-state-in-effect).
  const [loading, setLoading] = useState<boolean>(() => Boolean(requestId))
  const [loadError, setLoadError] = useState<boolean>(() => !requestId)
  const [mode, setMode] = useState<RespondMode>('idle')
  const [note, setNote] = useState('')
  const [responding, setResponding] = useState(false)
  const [respondError, setRespondError] = useState<string | null>(null)

  useEffect(() => {
    // No requestId → the initial state already reports the load error.
    if (!requestId) return
    let cancelled = false
    const repo = getSpatialSceneRepository()
    repo
      .findRescanRequestById(requestId)
      .then(async (found) => {
        if (cancelled) return
        setRequest(found)
        // Eagerly load the parent scene so the re-capture flow has the job /
        // project context ready when the customer accepts (B8). Missing parent
        // is a soft state — the request is still respondable; the scan-trigger
        // gates on parent presence separately.
        if (found) {
          try {
            const scene = await repo.findById(found.sceneId)
            if (!cancelled) setParentScene(scene)
          } catch {
            /* best-effort — re-capture surfaces its own error if scene missing */
          }
        }
        if (!cancelled) {
          setLoadError(found === null)
          setLoading(false)
        }
      })
      .catch(() => {
        if (cancelled) return
        setLoadError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [requestId])

  /**
   * Re-capture trigger (B8). Acceptable from two entry points:
   *   1. Auto-trigger right after the customer taps "Neuen Scan zusagen"
   *      (the response RPC sets `accepted` first, then this fires).
   *   2. Re-entry CTA on an already-accepted, still-unfulfilled request
   *      (customer returned to the screen between accept and capture).
   *
   * `parentSceneId` + `rescanRequestId` flow into `promoteScanToScene` →
   * the `spatial_create_scene` RPC writes them onto the new scene and
   * atomically links `spatial_rescan_requests.resulting_scene_id`. Idempotent
   * — re-firing on a fulfilled request returns the existing linked scene.
   */
  const triggerRecapture = useCallback(async () => {
    if (!request) return
    if (!parentScene) {
      toast.error('Original-Aufmaß nicht gefunden. Versuche es später nochmal.')
      return
    }
    if (!parentScene.sourceJobId) {
      // V1 cut: re-capture only for job-rooted scenes. Project-only scenes
      // (customer pre-job builder) don't carry a job id here — the customer
      // can re-scan via the builder flow instead.
      toast.error('Re-Aufmaß zurzeit nur für Aufträge verfügbar.')
      return
    }
    await startScan({
      jobId: parentScene.sourceJobId,
      parentSceneId: request.sceneId,
      rescanRequestId: request.id,
      onSuccess: (_result, scene) => {
        if (scene) {
          toast.success('Neuer Scan erstellt ✓')
          // Refresh the local request so the responded-state shows the
          // freshly-linked resulting scene.
          getSpatialSceneRepository()
            .findRescanRequestById(request.id)
            .then((fresh) => {
              if (fresh) setRequest(fresh)
            })
            .catch(() => {
              /* keep existing state — next mount reconciles */
            })
        }
      },
    })
  }, [request, parentScene, startScan, toast])

  const respond = useCallback(
    async (status: 'accepted' | 'rejected', responseNote: string | null) => {
      if (!requestId || responding) return
      setResponding(true)
      setRespondError(null)

      let applied: boolean
      try {
        applied = await getSpatialSceneRepository().respondToRescanRequest(
          requestId,
          status,
          responseNote,
        )
      } catch {
        // Only the WRITE failing is a real error.
        setRespondError('Antwort konnte nicht gespeichert werden. Bitte erneut versuchen.')
        setResponding(false)
        return
      }

      if (applied) {
        haptics.trigger(status === 'accepted' ? 'success' : 'medium')
      } else {
        // Idempotent no-op — the request was already answered (deep-link
        // opened twice, or answered on another device). Surface it instead of
        // silently showing a terminal state the customer did not just choose.
        haptics.trigger('warning')
        setRespondError('Diese Anfrage wurde bereits beantwortet.')
      }

      // Best-effort re-fetch — a failure HERE does not mean the write failed,
      // so it must not raise the "could not save" error.
      let refreshed: SpatialRescanRequest | null = null
      try {
        refreshed = await getSpatialSceneRepository().findRescanRequestById(requestId)
        setRequest(refreshed)
      } catch {
        /* keep the prior request object — re-open / refresh reconciles */
      }
      setMode('idle')
      setResponding(false)

      // Auto-trigger the re-capture flow once the accept transition lands
      // (B8). We fire-and-forget — `startScan` owns the busy state and
      // surfaces its own toasts. A fulfilled-then-re-tapped accept (applied
      // === false) skips this: the existing scene is already linked.
      if (status === 'accepted' && applied && refreshed && !refreshed.resultingSceneId) {
        void triggerRecapture()
      }
    },
    [requestId, responding, haptics, triggerRecapture],
  )

  // ── Loading / not-found ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas">
        <Spinner size="md" tone="brand" />
      </div>
    )
  }

  if (loadError || !request) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-canvas px-8 text-center">
        <AlertTriangle size={34} className="text-danger" />
        <p className="text-[15px] font-bold text-ink">Anfrage nicht gefunden</p>
        <p className="max-w-[260px] text-[12.5px] text-ink-sub">
          Diese Re-Scan-Anfrage existiert nicht mehr oder ist nicht für dich
          bestimmt.
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-white"
        >
          Zur Startseite
        </button>
      </div>
    )
  }

  const responded = request.status !== 'pending'

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center gap-1.5 bg-surface px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
        <button
          type="button"
          aria-label="Zurück"
          onClick={goBack}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-ink-sub"
        >
          <ChevronLeft size={19} />
        </button>
        <div className="text-[15px] font-bold tracking-tight text-ink">
          Erneutes Aufmaß
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-5">
        {/* Reason card */}
        <div className="rounded-card border border-edge bg-surface p-4 shadow-subtle">
          <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-[#EEF2FB] text-brand">
            <RotateCcw size={22} />
          </span>
          <p className="mt-3 text-[15px] font-bold text-ink">
            Der Handwerksbetrieb bittet um einen neuen Scan
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-sub">
            Damit das Angebot stimmt, wird der Raum noch einmal aufgenommen.
            Angegebener Grund:
          </p>
          <div className="mt-3 rounded-[10px] bg-canvas px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.4px] text-ink-muted">
              Grund
            </p>
            <p className="mt-0.5 text-[13.5px] font-[650] text-ink">{request.reason}</p>
          </div>
        </div>

        {/* Responded — terminal state */}
        {responded && (
          <div
            className={`mt-4 flex items-start gap-3 rounded-card border p-3.5 ${
              request.status === 'accepted'
                ? 'border-[#A7E8C8] bg-[#ECFDF3]'
                : 'border-[#F3C9C9] bg-[#FEF2F2]'
            }`}
          >
            {request.status === 'accepted' ? (
              <CheckCircle2 size={20} className="mt-px shrink-0 text-ok" />
            ) : (
              <XCircle size={20} className="mt-px shrink-0 text-danger" />
            )}
            <div>
              <p className="text-[13px] font-[750] text-ink">
                {request.status === 'accepted'
                  ? 'Du hast zugesagt'
                  : 'Du hast abgelehnt'}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-sub">
                {request.status === 'accepted'
                  ? request.resultingSceneId
                    ? 'Dein neuer Scan ist gespeichert. Der Betrieb ist informiert.'
                    : 'Der Betrieb ist informiert. Nimm den Raum neu auf, wann es dir passt.'
                  : 'Der Betrieb ist informiert.'}
                {request.responseNote ? ` Deine Notiz: „${request.responseNote}"` : ''}
              </p>
            </div>
          </div>
        )}

        {/* Re-entry CTA: accepted but no resulting scene yet (B8). */}
        {responded
          && request.status === 'accepted'
          && !request.resultingSceneId
          && (
            <div className="mt-4">
              <button
                type="button"
                disabled={scanBusy || responding}
                onClick={() => void triggerRecapture()}
                className="flex w-full items-center justify-center gap-2 rounded-[13px] bg-brand py-3.5 text-[14.5px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)] disabled:opacity-50"
              >
                <ScanLine size={17} />
                {scanBusy ? 'Aufnahme läuft …' : 'Aufnahme jetzt starten'}
              </button>
              <p className="mt-2 text-center text-[11.5px] leading-snug text-ink-muted">
                Wir öffnen die Raum-Aufnahme. Der Scan ersetzt das alte Aufmaß
                und der Betrieb sieht den neuen Stand automatisch.
              </p>
            </div>
          )}

        {/* Pending — action area */}
        {!responded && mode === 'idle' && (
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              disabled={responding}
              onClick={() => void respond('accepted', null)}
              className="flex w-full items-center justify-center gap-2 rounded-[13px] bg-brand py-3.5 text-[14.5px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)] disabled:opacity-50"
            >
              <CheckCircle2 size={17} />
              Neuen Scan zusagen
            </button>
            <button
              type="button"
              disabled={responding}
              onClick={() => {
                haptics.trigger('selection')
                setMode('rejecting')
              }}
              className="w-full rounded-[13px] border border-edge bg-surface py-3 text-[13.5px] font-bold text-ink-sub disabled:opacity-50"
            >
              Ablehnen
            </button>
          </div>
        )}

        {/* Pending — reject with optional note */}
        {!responded && mode === 'rejecting' && (
          <div className="mt-5">
            <p className="mb-1.5 text-[12px] font-bold text-ink-sub">
              Grund fürs Ablehnen <span className="font-[500] text-ink-muted">· optional</span>
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="z.B. Termin passt gerade nicht — bitte später erinnern."
              rows={3}
              className="w-full resize-none rounded-[10px] border border-edge bg-surface px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/10"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={responding}
                onClick={() => {
                  haptics.trigger('selection')
                  setMode('idle')
                }}
                className="flex-1 rounded-[12px] border border-edge bg-surface py-3 text-[13px] font-bold text-ink-sub disabled:opacity-50"
              >
                Zurück
              </button>
              <button
                type="button"
                disabled={responding}
                onClick={() => void respond('rejected', note.trim() || null)}
                className="flex-[1.4] rounded-[12px] bg-danger py-3 text-[13px] font-bold text-white disabled:opacity-50"
              >
                Ablehnen bestätigen
              </button>
            </div>
          </div>
        )}

        {respondError && (
          <p className="mt-3 text-center text-[12px] font-[600] text-danger">{respondError}</p>
        )}
      </div>
    </div>
  )
}
