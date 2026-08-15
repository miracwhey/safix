import { useRef, useState } from 'react'
import CorridorAction from '../system/CorridorAction'
import ProActionGuard from '../subscription/ProActionGuard'
import { useSubscription } from '../../hooks/useSubscription'
import { resolveActiveWorkContextForJob } from '../../lib/subscription/activeWorkContext'
import type { ProAction } from '../../lib/subscription/types'
import {
  deriveProviderJobPhase,
  PROVIDER_PHASE_CONFIG,
} from '../../lib/jobs/providerJobPhaseSelectors'
import {
  deriveProviderNextAction,
  type ProviderActionId,
} from '../../lib/jobs/providerNextActionSelectors'
import type { Job } from '../../lib/jobs'
import { getFundingRequestByJobId } from '../../lib/payments/fundingRequest'
import { getEscrowPlanByJobId, getEscrowTranches, initializeEscrowPlanRepository } from '../../lib/payments/escrow'
import type { EscrowTranche } from '../../lib/payments/escrow/escrowTypes'
import type { ProviderPayoutAccount } from '../../lib/payout/types'
import {
  startJob,
  completeJob,
} from '../../lib/workflow/craftsmanOperations'
import {
  confirmJobCompletionWorkflow,
  rejectWorkerCompletionWorkflow,
} from '../../lib/workflow/jobWorkflow'
import { useSession } from '../../hooks/useSession'
import {
  deriveTrancheReleaseState,
  deriveTrancheBlockedReason,
  type TrancheReleaseState,
} from '../../lib/workflow/releaseOperations'
import { releaseTrancheWorkflow } from '../../lib/workflow/paymentWorkflow'
import { requestServerFundingCreation } from '../../lib/payments/fundingClient'
import { formatEuro } from '../../lib/shared/formatters'
import { useToast } from '../../hooks/useToast'
import { useHaptics } from '../../hooks/useHaptics'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import { initializeFundingRequestRepository } from '../../lib/payments/fundingRequest'
import { initializeThreadArtifactRepository } from '../../lib/messages/repository/threadArtifactRegistry'

type CraftsmanJobOperationsCardProps = {
  job: Job
  /** Called after any operation succeeds so the parent can refresh state. */
  onOperationComplete: () => void
  /** Provider's payout account for release readiness checks. */
  providerPayoutAccount?: ProviderPayoutAccount | null
  /**
   * Called when the craftsman clicks "Folgeangebot erstellen" after a
   * completed diagnosis job (Paket 4d). Parent is responsible for navigating
   * to the message thread and opening the binding_offer composer pre-filled
   * from the diagnosis context.
   *
   * When `followUpOfferExists` is true the same callback navigates to the
   * existing follow-up offer instead of opening the composer.
   */
  onCreateFollowUpOffer?: () => void
  /**
   * Whether a follow-up binding_offer already exists for this diagnosis job.
   * Changes the CTA label from "Folgeangebot erstellen" → "Folgeangebot ansehen"
   * and adjusts the explanatory text so the craftsman is not misled into
   * creating a duplicate.
   */
  followUpOfferExists?: boolean
  /**
   * True while the offer repository is still hydrating (deferred repo).
   * When true, the follow-up CTA is shown as disabled/loading to prevent
   * accidental duplicate creation in the pre-hydration window where
   * followUpOfferExists may be a false negative.
   */
  followUpOfferLoading?: boolean
}

// ── Tranche status display helpers ────────────────────────────────────────

const RELEASE_STATE_CONFIG: Record<TrancheReleaseState, {
  label: string; icon: string; color: string
}> = {
  not_eligible: { label: 'Noch nicht freigabefähig', icon: '⏳', color: 'text-slate-500' },
  eligible: { label: 'Freigabefähig', icon: '✅', color: 'text-emerald-700' },
  payout_blocked: { label: 'Auszahlung blockiert', icon: '⚠️', color: 'text-amber-700' },
  release_pending: { label: 'Freigabe läuft', icon: '⏳', color: 'text-blue-700' },
  released: { label: 'Freigegeben', icon: '💶', color: 'text-emerald-700' },
  disputed: { label: 'Streitfall', icon: '⚖️', color: 'text-red-700' },
}

// Phases in which per-tranche release details are shown
const RELEASE_PHASES = new Set([
  'work_started', 'work_completed', 'awaiting_release',
  'partially_released', 'payment_released', 'closed',
])

function getTrancheLabel(kind: EscrowTranche['kind']): string {
  return kind === 'deposit_release' ? '25 % Arbeitsbeginn' : '75 % Fertigstellung'
}

/**
 * Real provider-side operations card.
 *
 * Shows the current operational phase + one clear primary action CTA.
 * Calls guarded operation commands from craftsmanOperations.ts.
 * Handles loading, error, and disabled states.
 *
 * When the job reaches release-relevant phases (awaiting_release,
 * partially_released, payment_released), shows per-tranche release
 * state with real release CTAs and blocked-reason visibility.
 */
export default function CraftsmanJobOperationsCard({
  job,
  onOperationComplete,
  providerPayoutAccount = null,
  onCreateFollowUpOffer,
  followUpOfferExists = false,
  followUpOfferLoading = false,
}: CraftsmanJobOperationsCardProps) {
  const toast = useToast()
  const haptics = useHaptics()
  const subscription = useSubscription()
  const session = useSession()
  const jobContext = resolveActiveWorkContextForJob(job.id)
  const [loading, setLoading] = useState(false)
  const inflightRef = useRef(false)
  const [releasingTrancheId, setReleasingTrancheId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [adminConfirmInflight, setAdminConfirmInflight] = useState<'confirm' | 'reject' | null>(null)

  // Block 7.2.1b — admin-confirm-gate: show explicit confirm/reject CTAs to
  // the owner when a worker has reported the job finished but the owner has
  // not yet confirmed.
  const isOwnerCaller =
    session.craftsmanRole === 'owner' &&
    !!session.user &&
    job.craftsmanUserId === session.user.id
  const awaitingAdminConfirmation =
    !!job.workMarkedCompleteAt && !job.workConfirmedCompleteAt
  const showAdminConfirmSurface = isOwnerCaller && awaitingAdminConfirmation

  const handleAdminConfirm = async () => {
    if (adminConfirmInflight) return
    setAdminConfirmInflight('confirm')
    try {
      const updated = await confirmJobCompletionWorkflow(job.id)
      if (!updated || !updated.workConfirmedCompleteAt) {
        toast.error('Bestätigung konnte nicht gespeichert werden.')
        return
      }
      toast.success('Auftrag bestätigt.')
      onOperationComplete()
    } catch {
      toast.error('Ein unerwarteter Fehler ist aufgetreten.')
    } finally {
      setAdminConfirmInflight(null)
    }
  }

  const handleAdminReject = async () => {
    if (adminConfirmInflight) return
    setAdminConfirmInflight('reject')
    try {
      const updated = await rejectWorkerCompletionWorkflow(job.id)
      if (!updated || updated.workMarkedCompleteAt) {
        toast.error('Ablehnung konnte nicht gespeichert werden.')
        return
      }
      toast.success('Bestätigung zurück an Worker gegeben.')
      onOperationComplete()
    } catch {
      toast.error('Ein unerwarteter Fehler ist aufgetreten.')
    } finally {
      setAdminConfirmInflight(null)
    }
  }

  const fundingRequest = getFundingRequestByJobId(job.id)
  const escrowPlan = getEscrowPlanByJobId(job.id)
  const canonicalAmount = resolveCanonicalAmount(job.id)

  const phaseVM = deriveProviderJobPhase(job, fundingRequest?.status, escrowPlan?.status)
  const nextAction = deriveProviderNextAction(job, fundingRequest?.status, escrowPlan?.status)
  const phaseConfig = PROVIDER_PHASE_CONFIG[phaseVM.phase]

  // ── Diagnosis path: override phase display labels ──────────────────────
  const isDiagnosisJob = job.jobKind === 'diagnosis'
  const diagnosisPhaseLabel: string | null = isDiagnosisJob
    ? (() => {
        switch (phaseVM.phase) {
          case 'quote_sent': return 'Diagnose-Anfrage gesendet'
          case 'quote_accepted':
          case 'funding_not_requested':
          case 'funding_requested':
          case 'funding_pending':
          case 'funded_in_escrow': return 'Diagnoseeinsatz freigegeben'
          case 'work_started': return 'Diagnoseeinsatz läuft'
          case 'work_completed':
          case 'awaiting_release': return 'Diagnoseeinsatz abgeschlossen'
          case 'closed': return 'Diagnoseeinsatz abgeschlossen'
          default: return null
        }
      })()
    : null

  const diagnosisPhaseIcon: string | null = isDiagnosisJob
    ? (() => {
        switch (phaseVM.phase) {
          case 'quote_sent': return '🔍'
          case 'quote_accepted':
          case 'funding_not_requested':
          case 'funding_requested':
          case 'funding_pending':
          case 'funded_in_escrow': return '✅'
          case 'work_started': return '🔬'
          case 'work_completed':
          case 'awaiting_release':
          case 'closed': return '🏁'
          default: return null
        }
      })()
    : null

  const displayPhaseIcon = diagnosisPhaseIcon ?? phaseConfig.icon
  const displayPhaseLabel = diagnosisPhaseLabel ?? phaseConfig.label

  // Show diagnosis follow-path hint after the einsatz is done
  const showDiagnosisFollowPath = isDiagnosisJob && (
    phaseVM.phase === 'work_completed' ||
    phaseVM.phase === 'awaiting_release' ||
    phaseVM.phase === 'closed'
  )

  // Derive tranche release states when relevant
  const showReleaseDetails = escrowPlan && RELEASE_PHASES.has(phaseVM.phase)
  const tranches = showReleaseDetails ? getEscrowTranches(escrowPlan.id) : []

  const handleAction = async (actionId: ProviderActionId) => {
    if (inflightRef.current) return
    inflightRef.current = true
    setLoading(true)
    setErrorMessage(null)

    try {
      let successMsg = ''
      switch (actionId) {
        case 'request_funding': {
          const result = await requestServerFundingCreation(job.id)
          if (!result.ok) {
            setErrorMessage(result.message)
            toast.error(result.message)
            return
          }
          await Promise.all([
            initializeEscrowPlanRepository(),
            initializeFundingRequestRepository(),
            initializeThreadArtifactRepository(),
          ])
          successMsg = 'Zahlungsanfrage erstellt'
          break
        }
        case 'start_work': {
          const result = await startJob(job.id)
          if (!result.ok) {
            setErrorMessage(result.message)
            toast.error(result.message)
            return
          }
          successMsg = 'Arbeit gestartet'
          break
        }
        case 'complete_work': {
          const result = await completeJob(job.id)
          if (!result.ok) {
            setErrorMessage(result.message)
            toast.error(result.message)
            return
          }
          // Terminal-success haptik for the job-completion ("Arbeit/Diagnose-
          // einsatz abschließen") moment, mirroring the accept-success pattern
          // (QuoteDetailScreen.handleAccept: haptics.success() + toast). Scoped
          // to complete_work only — request_funding/start_work are intermediate
          // steps, not "you're done" moments. Fired inside the click handler,
          // so it never fires on mount of an already-completed card.
          haptics.success()
          successMsg = 'Arbeit abgeschlossen'
          break
        }
        default:
          return // unknown action — no toast, no callback
      }

      toast.success(successMsg)
      onOperationComplete()
    } catch {
      const msg = 'Ein unerwarteter Fehler ist aufgetreten.'
      setErrorMessage(msg)
      toast.error(msg)
    } finally {
      inflightRef.current = false
      setLoading(false)
    }
  }

  const handleReleaseTranche = async (trancheId: string) => {
    if (releasingTrancheId) return // Prevent double-click
    if (!escrowPlan) return
    setReleasingTrancheId(trancheId)
    setErrorMessage(null)

    try {
      // releaseTrancheWorkflow: dispute guard → server release → repo reload → side effects.
      // This ensures Path A (UI-triggered) produces the same domain truth as
      // Path B (orchestration via releaseEligibleTranche).
      const result = await releaseTrancheWorkflow(trancheId, escrowPlan.id, escrowPlan.jobId)
      if (!result.ok) {
        toast.error(result.message)
        setReleasingTrancheId(null)
        return
      }

      // Reconciliation case: Stripe Transfer succeeded but the Supabase row
      // could not be updated. Money has moved at the provider level; SaFix's
      // reconciliation cron will heal the canonical state. Show an honest
      // fachlicher Hinweis instead of a "Tranche freigegeben"-Erfolg, so the
      // craftsman is not misled about the persisted state.
      if (result.data.requiresReconciliation === true) {
        setReleasingTrancheId(null)
        toast.info(
          'Übergabe an das Auszahlungskonto ist erfolgt. Endgültige Buchung wird automatisch nachgeholt — bitte gleich erneut prüfen.',
        )
        onOperationComplete()
        return
      }

      // Corridor async case (PAYOUT_MODE): the server initiated a payout
      // (release_pending) or deferred it pending balance (release_deferred). No
      // money has moved yet — the payout pays in a few business days and the
      // payout.paid webhook then settles. Show an honest "veranlasst"-hint, NOT a
      // "freigegeben"-success (the money has not arrived).
      if (result.data.status !== 'released') {
        setReleasingTrancheId(null)
        toast.info(
          'Auszahlung wurde veranlasst — das Geld trifft in wenigen Werktagen auf dem Auszahlungskonto ein.',
        )
        onOperationComplete()
        return
      }

      setReleasingTrancheId(null)
      toast.success('Tranche freigegeben')
      onOperationComplete()
    } catch {
      toast.error('Freigabe fehlgeschlagen. Bitte versuche es erneut.')
      setReleasingTrancheId(null)
    }
  }

  // Only show the card for jobs that have moved past the initial inquiry stage
  const showCard =
    job.proposalAcceptedAt ||
    job.status === 'booked' ||
    job.status === 'in_progress' ||
    job.status === 'waiting_payment' ||
    job.status === 'completed'

  if (!showCard) return null

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-18px_rgba(2,6,23,0.10)]">
      {/* Phase indicator */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[18px]">{displayPhaseIcon}</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${phaseConfig.badge}`}
        >
          {displayPhaseLabel}
        </span>
      </div>

      {/* Description of next action */}
      <p className="text-[13px] text-slate-600 mb-3 leading-relaxed">
        {nextAction.description}
      </p>

      {/* Block 7.2.1b — admin-confirm-gate surface for owner */}
      {showAdminConfirmSurface && (
        <div
          data-testid="admin-confirm-surface"
          className="mb-3 rounded-[14px] bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200/60"
        >
          <p className="text-[12px] font-semibold text-amber-800 mb-1">
            🛠️ Worker hat fertig gemeldet
          </p>
          <p className="text-[11px] leading-relaxed text-amber-900/80 mb-2">
            Bitte prüfen und bestätigen, damit die Abnahme beim Kunden öffnet.
          </p>
          <div className="flex flex-col gap-2">
            <CorridorAction
              variant="primary"
              size="sm"
              loading={adminConfirmInflight === 'confirm'}
              disabled={adminConfirmInflight !== null}
              onClick={handleAdminConfirm}
            >
              {adminConfirmInflight === 'confirm'
                ? 'Wird bestätigt…'
                : 'Auftrag bestätigen & abschließen'}
            </CorridorAction>
            <CorridorAction
              variant="secondary"
              size="sm"
              loading={adminConfirmInflight === 'reject'}
              disabled={adminConfirmInflight !== null}
              onClick={handleAdminReject}
            >
              {adminConfirmInflight === 'reject'
                ? 'Wird zurückgegeben…'
                : 'Zurück zum Worker'}
            </CorridorAction>
          </div>
        </div>
      )}

      {/* Diagnosis follow-path — shown after einsatz is completed */}
      {showDiagnosisFollowPath && (
        <div className="mb-3 rounded-[14px] bg-purple-50 px-3 py-2.5 ring-1 ring-purple-200/60">
          <p className="text-[12px] font-semibold text-purple-700 mb-1">🔍 Nächste Schritte nach der Diagnose</p>
          <p className="text-[11px] leading-relaxed text-purple-700/80 mb-2">
            {followUpOfferLoading
              ? 'Angebotsstatus wird geladen…'
              : followUpOfferExists
                ? 'Du hast bereits ein Folgeangebot für weitere Ausführungsarbeiten erstellt. Der Kunde kann es annehmen oder ablehnen.'
                : 'Bespreche die Diagnoseergebnisse mit dem Kunden und stimme das weitere Vorgehen ab. Falls weitere Ausführungsarbeiten nötig sind, erstelle ein neues verbindliches Angebot.'}
          </p>
          {onCreateFollowUpOffer && (
            <CorridorAction
              variant="primary"
              size="sm"
              disabled={followUpOfferLoading}
              onClick={onCreateFollowUpOffer}
            >
              {followUpOfferLoading
                ? 'Wird geladen…'
                : followUpOfferExists
                  ? 'Folgeangebot ansehen'
                  : 'Folgeangebot erstellen'}
            </CorridorAction>
          )}
        </div>
      )}

      {/* Funding details if relevant */}
      {(() => {
        const FUNDING_PHASES = new Set(['funding_not_requested', 'funding_requested', 'funding_pending', 'funded_in_escrow'])
        const showFundingDetails = escrowPlan && FUNDING_PHASES.has(phaseVM.phase)
        if (!showFundingDetails) return null
        return (
          <div className="mb-3 rounded-[14px] bg-slate-50 px-3 py-2 ring-1 ring-slate-200/50">
            <div className="flex justify-between text-[12px]">
              <span className="text-slate-500">Auftragswert</span>
              <span className="font-semibold text-slate-700">
                {canonicalAmount.formatted ?? formatEuro(escrowPlan.totalAmount)}
              </span>
            </div>
            <div className="flex justify-between text-[12px] mt-1">
              <span className="text-slate-500">Betrag</span>
              <span className="font-semibold text-slate-700">
                {formatEuro(escrowPlan.totalAmount)}
              </span>
            </div>
            {fundingRequest && (
              <div className="flex justify-between text-[12px] mt-1">
                <span className="text-slate-500">Einzahlungsstatus</span>
                <span className="font-medium text-slate-600">
                  {fundingRequest.status === 'funded' ? '✅ Eingezahlt' :
                   fundingRequest.status === 'sent' ? '📨 Gesendet' :
                   fundingRequest.status === 'funding_started' ? '⏳ Gestartet' :
                   fundingRequest.status === 'funding_initiated' ? '⏳ Verarbeitung' :
                   fundingRequest.status === 'created' ? '📋 Erstellt' :
                   fundingRequest.status === 'funding_failed' ? '⚠️ Fehlgeschlagen' :
                   fundingRequest.status === 'expired' ? '⏰ Abgelaufen' :
                   fundingRequest.status === 'cancelled' ? '❌ Storniert' :
                   '⏳ Verarbeitung'}
                </span>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Tranche release details ── */}
      {showReleaseDetails && tranches.length > 0 && (
        <div className="mb-3 space-y-2">
          {tranches.map((tranche) => {
            const releaseState = deriveTrancheReleaseState(tranche, providerPayoutAccount, job.status)
            const stateConfig = RELEASE_STATE_CONFIG[releaseState]
            const blockedReason = deriveTrancheBlockedReason(tranche, providerPayoutAccount, job.status)

            return (
              <div
                key={tranche.id}
                className="rounded-[14px] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/50"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-slate-600 font-medium">
                    {getTrancheLabel(tranche.kind)}
                  </span>
                  <span className={`text-[11px] font-semibold ${stateConfig.color}`}>
                    {stateConfig.icon} {stateConfig.label}
                  </span>
                </div>

                <div className="flex items-center justify-between mt-1">
                  <span className="text-[12px] text-slate-500">
                    {formatEuro(tranche.amount)}
                  </span>
                  {tranche.releasedAt && (
                    <span className="text-[11px] text-slate-400">
                      {new Date(tranche.releasedAt).toLocaleDateString('de-DE')}
                    </span>
                  )}
                </div>

                {/* Blocked reason */}
                {blockedReason && releaseState !== 'released' && (
                  <p className="mt-1.5 text-[11px] leading-snug text-amber-700">
                    {blockedReason}
                  </p>
                )}

                {/* Release CTA — only when eligible, Pro-gated */}
                {releaseState === 'eligible' && (
                  <ProActionGuard
                    action="release_tranche"
                    effectiveState={subscription.effectiveState}
                    scope={subscription.scope}
                    jobContext={jobContext ?? undefined}
                    onAction={() => handleReleaseTranche(tranche.id)}
                    onTrialStarted={subscription.refetch}
                  >
                    {(guardedOnClick) => (
                      <CorridorAction
                        variant="primary"
                        size="sm"
                        loading={releasingTrancheId === tranche.id}
                        onClick={guardedOnClick}
                        className="mt-2"
                      >
                        {releasingTrancheId === tranche.id
                          ? 'Wird freigegeben…'
                          : `${getTrancheLabel(tranche.kind)} freigeben`}
                      </CorridorAction>
                    )}
                  </ProActionGuard>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <div className="mb-3 rounded-[12px] bg-red-50 px-3 py-2 text-[12px] text-red-700 ring-1 ring-red-200">
          {errorMessage}
        </div>
      )}

      {/* Primary action CTA — hide when there are active tranche release CTAs,
          but show when in a release phase with NO eligible tranche (e.g. after
          deposit released, provider needs to complete work) */}
      {(() => {
        const hasEligibleTrancheCTA = showReleaseDetails && tranches.some((t) =>
          deriveTrancheReleaseState(t, providerPayoutAccount, job.status) === 'eligible'
        )
        const showPrimary = !RELEASE_PHASES.has(phaseVM.phase) || !hasEligibleTrancheCTA
        return showPrimary
      })() && nextAction.enabled ? (() => {
        const proAction = mapProviderActionToProAction(nextAction.actionId)
        // Unknown actions (wait states, view_dispute, none) → render without gate.
        // handleAction already no-ops for unknown actionIds.
        if (!proAction) {
          return (
            <CorridorAction
              variant="primary"
              loading={loading}
              onClick={() => handleAction(nextAction.actionId)}
            >
              {loading ? 'Wird ausgeführt…' : nextAction.label}
            </CorridorAction>
          )
        }
        return (
          <ProActionGuard
            action={proAction}
            effectiveState={subscription.effectiveState}
            scope={subscription.scope}
            jobContext={jobContext ?? undefined}
            onAction={() => handleAction(nextAction.actionId)}
            onTrialStarted={subscription.refetch}
          >
            {(guardedOnClick) => (
              <CorridorAction
                variant="primary"
                loading={loading}
                onClick={guardedOnClick}
              >
                {loading ? 'Wird ausgeführt…' : nextAction.label}
              </CorridorAction>
            )}
          </ProActionGuard>
        )
      })() : (() => {
        const hasEligibleTrancheCTA = showReleaseDetails && tranches.some((t) =>
          deriveTrancheReleaseState(t, providerPayoutAccount, job.status) === 'eligible'
        )
        const showPrimary = !RELEASE_PHASES.has(phaseVM.phase) || !hasEligibleTrancheCTA
        return showPrimary
      })() ? (
        <CorridorAction variant="primary" disabled onClick={() => {}}>
          {nextAction.label}
          {nextAction.disabledReason && (
            <span className="block mt-0.5 text-[11px] opacity-70">
              {nextAction.disabledReason}
            </span>
          )}
        </CorridorAction>
      ) : null}
    </div>
  )
}

function mapProviderActionToProAction(actionId: ProviderActionId): ProAction | null {
  switch (actionId) {
    case 'request_funding': return 'request_funding'
    case 'start_work': return 'start_job'
    case 'complete_work': return 'complete_job'
    default: return null // unknown actions must not map to an AWE-allowed action
  }
}
