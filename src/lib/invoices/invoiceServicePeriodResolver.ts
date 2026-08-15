/**
 * Block 7.1B3 — Service-Period-Resolver gemäß §14 (4) Nr. 6 UStG.
 *
 * Liefert einen Default-Vorschlag für den Leistungszeitraum auf Basis
 * existierender Job-/Schedule-Daten. Der IssueInvoiceSheet zeigt das Ergebnis
 * an, lässt den Provider den Zeitraum bestätigen oder anpassen, und gibt das
 * finale Ergebnis als Snapshot in die Rechnung.
 *
 * Reihenfolge der Quellen (kann je nach Job leer bleiben):
 *   1. JobSchedule (`scheduled_start`, `scheduled_end`) — Plan-Zeitraum, gut
 *      wenn der Job tatsächlich am geplanten Tag ausgeführt wurde.
 *   2. Job-Workflow-Timestamps (`workCompletedAt` ist der Endpunkt; falls
 *      `proposalAcceptedAt` vorliegt, wird er als Start verwendet — das ist
 *      ein konservativer Fallback und wird im UI immer als „bitte
 *      bestätigen" markiert).
 *   3. Wenn nur ein Datum bekannt ist, wird es als Leistungsdatum behandelt.
 *
 * Modul ist pure (keine I/O). Aufrufer holen Job + Schedule aus den
 * jeweiligen Domains und übergeben sie hier.
 */

import type { Job } from '../jobs'
import type { JobSchedule } from '../operations/types'
import type { InvoiceServicePeriod } from './types'

function formatGermanDate(timestamp: number): string {
  const date = new Date(timestamp)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  return `${day}.${month}.${year}`
}

function isSameCalendarDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function buildLabel(from: number | null, to: number | null): string {
  if (from === null && to === null) return ''
  if (from !== null && to !== null && !isSameCalendarDay(from, to)) {
    return `Leistungszeitraum: ${formatGermanDate(from)} – ${formatGermanDate(to)}`
  }
  const single = to ?? from
  return single !== null ? `Leistungsdatum: ${formatGermanDate(single)}` : ''
}

export type ServicePeriodInput = {
  job: Pick<Job, 'workCompletedAt' | 'proposalAcceptedAt'>
  schedule?: Pick<JobSchedule, 'scheduledStart' | 'scheduledEnd'> | null
}

/**
 * Liefert einen Default-Vorschlag für den Leistungszeitraum. Niemals leer
 * fallback-en — wenn keine der Quellen ein Datum liefert, gibt der Resolver
 * NULL zurück und der IssueSheet zwingt den Provider, manuell ein Datum
 * einzugeben (Hard-Gate).
 */
export function resolveDefaultServicePeriod(
  input: ServicePeriodInput,
): InvoiceServicePeriod | null {
  const { job, schedule } = input

  const scheduleStart =
    schedule?.scheduledStart && schedule.scheduledStart > 0
      ? schedule.scheduledStart
      : null
  const scheduleEnd =
    schedule?.scheduledEnd && schedule.scheduledEnd > 0
      ? schedule.scheduledEnd
      : null

  // 1. Wenn ein Plan-Zeitraum existiert UND der Job tatsächlich abgeschlossen
  //    wurde, ziehe den Plan als Standard-Vorschlag.
  if (scheduleStart && scheduleEnd) {
    return {
      from: scheduleStart,
      to: scheduleEnd,
      label: buildLabel(scheduleStart, scheduleEnd),
    }
  }

  // 2. Sonst: workCompletedAt als Endpunkt, proposalAcceptedAt als Start
  //    (falls beide vorhanden sind).
  if (job.workCompletedAt && job.workCompletedAt > 0) {
    const from =
      job.proposalAcceptedAt && job.proposalAcceptedAt > 0
        ? job.proposalAcceptedAt
        : null
    return {
      from,
      to: job.workCompletedAt,
      label: buildLabel(from, job.workCompletedAt),
    }
  }

  // 3. Nichts greifbar — manuelle Eingabe ist zwingend.
  return null
}

/**
 * Normalisiert eine vom IssueSheet zurückgegebene Service-Period: trimmt das
 * Label, sorgt dafür, dass `from`/`to` nicht beide null sind, generiert das
 * Label aus den Daten falls leer.
 */
export function normalizeServicePeriod(
  period: InvoiceServicePeriod,
): InvoiceServicePeriod | null {
  const from = period.from ?? null
  const to = period.to ?? null
  if (from === null && to === null && !period.label.trim()) {
    return null
  }
  const label = period.label.trim() || buildLabel(from, to)
  if (!label) return null
  return { from, to, label }
}
