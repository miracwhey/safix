import type { JobStatus, PaymentState } from '../shared/coreTypes'
import type { DisputeStatus } from '../disputes/types'
import type { SchedulingStatus } from '../operations/types'

export type HealthStatus = 'ok' | 'warning' | 'critical' | 'pending' | 'inactive'

export type ProjectHealthIndicator = {
  id: string
  label: string
  statusLabel: string
  status: HealthStatus
  icon: string
  /** Optional navigation target when indicator needs attention */
  actionHref?: string
}

export type ProjectHealthSummaryViewModel = {
  overallStatus: HealthStatus
  overallLabel: string
  indicators: ProjectHealthIndicator[]
}

function deriveJobIndicator(jobStatus: JobStatus): ProjectHealthIndicator {
  switch (jobStatus) {
    case 'new':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Neue Anfrage', status: 'pending', icon: '📋' }
    case 'booked':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Auftrag bestätigt', status: 'ok', icon: '📋' }
    case 'scheduled':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Termin geplant', status: 'ok', icon: '📅' }
    case 'in_progress':
      return { id: 'job', label: 'Auftrag', statusLabel: 'In Durchführung', status: 'ok', icon: '🔨' }
    case 'waiting_payment':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Arbeit abgeschlossen', status: 'warning', icon: '⏳' }
    case 'completed':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Abgeschlossen', status: 'ok', icon: '✅' }
    case 'cancelled':
      return { id: 'job', label: 'Auftrag', statusLabel: 'Storniert', status: 'inactive', icon: '🚫' }
  }
}

function derivePaymentIndicator(paymentState: PaymentState | undefined): ProjectHealthIndicator {
  if (!paymentState) {
    return { id: 'payment', label: 'Zahlung', statusLabel: 'Keine Zahlung', status: 'inactive', icon: '💳' }
  }
  switch (paymentState) {
    case 'none':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Keine Zahlung', status: 'inactive', icon: '💳' }
    case 'deposit_required':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Einzahlung ausstehend', status: 'warning', icon: '💳' }
    case 'deposit_paid':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Einzahlung bestätigt', status: 'ok', icon: '💳' }
    case 'in_escrow':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'In Zahlung', status: 'ok', icon: '🔒' }
    case 'work_in_progress':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Arbeit läuft', status: 'ok', icon: '🔒' }
    case 'release_pending':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Freigabe ausstehend', status: 'warning', icon: '⏳' }
    case 'released':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Freigegeben', status: 'ok', icon: '✅' }
    case 'disputed':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Eingefroren', status: 'critical', icon: '🚫' }
    case 'refunded':
      return { id: 'payment', label: 'Zahlung', statusLabel: 'Erstattet', status: 'ok', icon: '↩️' }
    case 'diagnosis_payment_pending':
      return { id: 'payment', label: 'Diagnose-Zahlung', statusLabel: 'Sofortzahlung ausstehend', status: 'warning', icon: '💳' }
    case 'diagnosis_payment_completed':
      return { id: 'payment', label: 'Diagnose-Zahlung', statusLabel: 'Zahlung abgeschlossen', status: 'ok', icon: '✅' }
  }
}

function deriveDisputeIndicator(disputeStatus: DisputeStatus | undefined): ProjectHealthIndicator {
  if (!disputeStatus) {
    return { id: 'dispute', label: 'Konflikt', statusLabel: 'Kein Konflikt', status: 'inactive', icon: '⚖️' }
  }
  switch (disputeStatus) {
    case 'open':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Offen', status: 'critical', icon: '⚖️' }
    case 'customer_waiting':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Warte auf Kundenbeleg', status: 'critical', icon: '⚖️' }
    case 'provider_waiting':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Warte auf Anbieterbeleg', status: 'critical', icon: '⚖️' }
    case 'under_review':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'In Prüfung', status: 'warning', icon: '⚖️' }
    case 'resolved':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Entschieden', status: 'ok', icon: '✅' }
    case 'closed':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Geschlossen', status: 'ok', icon: '✅' }
    case 'cancelled':
      return { id: 'dispute', label: 'Konflikt', statusLabel: 'Storniert', status: 'inactive', icon: '⚖️' }
  }
}

function deriveSchedulingIndicator(schedulingStatus: SchedulingStatus | undefined): ProjectHealthIndicator {
  if (!schedulingStatus) {
    return { id: 'schedule', label: 'Terminplanung', statusLabel: 'Nicht geplant', status: 'inactive', icon: '📅' }
  }
  switch (schedulingStatus) {
    case 'scheduled':
      return { id: 'schedule', label: 'Terminplanung', statusLabel: 'Termin gesetzt', status: 'ok', icon: '📅' }
    case 'execution_started':
      return { id: 'schedule', label: 'Terminplanung', statusLabel: 'Ausführung gestartet', status: 'ok', icon: '▶️' }
    case 'execution_completed':
      return { id: 'schedule', label: 'Terminplanung', statusLabel: 'Ausführung abgeschlossen', status: 'ok', icon: '✅' }
    case 'cancelled':
      return { id: 'schedule', label: 'Terminplanung', statusLabel: 'Storniert', status: 'warning', icon: '❌' }
  }
}

function deriveArtifactIndicator(artifactCount: number): ProjectHealthIndicator {
  if (artifactCount === 0) {
    return { id: 'artifacts', label: 'Dokumentation', statusLabel: 'Keine Medien', status: 'inactive', icon: '📷' }
  }
  return {
    id: 'artifacts',
    label: 'Dokumentation',
    statusLabel: `${artifactCount} ${artifactCount === 1 ? 'Datei' : 'Dateien'}`,
    status: 'ok',
    icon: '📷',
  }
}

function computeOverallStatus(indicators: ProjectHealthIndicator[]): HealthStatus {
  if (indicators.some((i) => i.status === 'critical')) return 'critical'
  if (indicators.some((i) => i.status === 'warning')) return 'warning'
  if (indicators.some((i) => i.status === 'pending')) return 'pending'
  if (indicators.every((i) => i.status === 'inactive')) return 'inactive'
  return 'ok'
}

function getOverallLabel(status: HealthStatus): string {
  switch (status) {
    case 'critical':
      return 'Handlungsbedarf'
    case 'warning':
      return 'Aufmerksamkeit erforderlich'
    case 'pending':
      return 'Wartet auf Aktion'
    case 'ok':
      return 'Alles im grünen Bereich'
    case 'inactive':
      return 'Noch nicht gestartet'
  }
}

/**
 * Derives a high-level project health summary from all relevant lifecycle
 * dimensions: job status, payment state, dispute status, scheduling status,
 * and artifact presence.
 *
 * This is a pure read-helper — no transitions or mutations occur here.
 */
export function deriveProjectHealth(
  jobStatus: JobStatus,
  paymentState: PaymentState | undefined,
  disputeStatus: DisputeStatus | undefined,
  schedulingStatus: SchedulingStatus | undefined,
  artifactCount: number
): ProjectHealthSummaryViewModel {
  const indicators = [
    deriveJobIndicator(jobStatus),
    derivePaymentIndicator(paymentState),
    deriveDisputeIndicator(disputeStatus),
    deriveSchedulingIndicator(schedulingStatus),
    deriveArtifactIndicator(artifactCount),
  ]

  // Cross-indicator consistency: work is active but supporting dimensions are missing
  const isActiveWork = jobStatus === 'in_progress' || jobStatus === 'waiting_payment'
  if (isActiveWork) {
    const scheduleIdx = indicators.findIndex((i) => i.id === 'schedule')
    if (scheduleIdx !== -1 && indicators[scheduleIdx].status === 'inactive') {
      indicators[scheduleIdx] = {
        ...indicators[scheduleIdx],
        statusLabel: 'Kein Ausführungsfenster',
        status: 'warning',
      }
    }
    const artifactIdx = indicators.findIndex((i) => i.id === 'artifacts')
    if (artifactIdx !== -1 && indicators[artifactIdx].status === 'inactive') {
      indicators[artifactIdx] = {
        ...indicators[artifactIdx],
        statusLabel: 'Dokumentation fehlt',
        status: 'warning',
      }
    }
  }

  // Attach action hrefs for actionable indicators
  const ACTION_HREFS: Record<string, string> = {
    schedule: '/craftsman/operations',
    dispute: '/craftsman/disputes',
    payment: '/craftsman/finance',
  }
  for (const indicator of indicators) {
    if (indicator.status === 'warning' || indicator.status === 'critical') {
      indicator.actionHref = ACTION_HREFS[indicator.id]
    }
  }

  const overallStatus = computeOverallStatus(indicators)

  return {
    overallStatus,
    overallLabel: getOverallLabel(overallStatus),
    indicators,
  }
}
