const DAY_NAMES_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const

/**
 * Formats a Unix-epoch millisecond timestamp into the short German label
 * shown in message bubbles and conversation list rows.
 *
 * @param sentAtMs - Unix epoch milliseconds of when the message was sent.
 *
 * Rules (relative to the caller's local time):
 *   – today                → 'HH:MM'          e.g. '14:30'
 *   – yesterday            → 'Gestern'
 *   – within the last week → day abbreviation  e.g. 'Mo'
 *   – older                → 'DD.MM.'          e.g. '15.01.'
 *
 * The label is computed on-the-fly from the stored epoch timestamp so it
 * remains accurate after a reload without requiring a dedicated DB column.
 */
export function formatMessageTimeLabel(sentAtMs: number): string {
  const now = new Date()
  const sent = new Date(sentAtMs)

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000)
  const startOfWeekAgo = new Date(startOfToday.getTime() - 6 * 86_400_000)

  if (sent >= startOfToday) {
    const hh = String(sent.getHours()).padStart(2, '0')
    const mm = String(sent.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  if (sent >= startOfYesterday) {
    return 'Gestern'
  }
  if (sent >= startOfWeekAgo) {
    return DAY_NAMES_DE[sent.getDay()]
  }
  const dd = String(sent.getDate()).padStart(2, '0')
  const mo = String(sent.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mo}.`
}
