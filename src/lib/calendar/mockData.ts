import type { CalendarEntry } from './calendarTypes'

// Compute today-relative date keys so these entries remain current regardless of when they're loaded
function dateKey(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Fixed in-memory provider ID used to scope all mock calendar entries to a
 * single demo company.  Matches the provider-id used in in-memory job seed
 * data so that createCalendarEntryFromJob() produces consistent providerId
 * values in demo mode.
 */
export const MOCK_PROVIDER_ID = 'provider-demo-1'

export const mockCalendarEntries: CalendarEntry[] = [
  {
    id: 'cal_1',
    kind: 'job',
    jobId: 'job-1',
    providerId: MOCK_PROVIDER_ID,
    title: 'Badsanierung – Leitungen prüfen',
    description: '',
    customerName: 'Max Mustermann',
    location: 'Hannover-Linden',
    dateLabel: 'Heute',
    dateKey: dateKey(0),
    startsAtLabel: '14:00',
    endsAtLabel: '16:30',
    assignedMemberIds: ['tm-1', 'tm-2'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'cal_2',
    kind: 'job',
    jobId: 'job-2',
    providerId: MOCK_PROVIDER_ID,
    title: 'Sicherungskasten austauschen',
    description: '',
    customerName: 'Anna Becker',
    location: 'Hannover-Mitte',
    dateLabel: 'Morgen',
    dateKey: dateKey(1),
    startsAtLabel: '09:30',
    endsAtLabel: '12:00',
    assignedMemberIds: ['tm-3'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'cal_3',
    kind: 'job',
    jobId: 'job-4',
    providerId: MOCK_PROVIDER_ID,
    title: 'Heizkörper entlüften & prüfen',
    description: '',
    customerName: 'Julia Neumann',
    location: 'Hannover-Südstadt',
    dateLabel: 'Gestern',
    dateKey: dateKey(-1),
    startsAtLabel: '13:00',
    endsAtLabel: '14:15',
    assignedMemberIds: ['tm-2'],
    status: 'awaiting_payment',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'cal_4',
    kind: 'job',
    jobId: 'job-3',
    providerId: MOCK_PROVIDER_ID,
    title: 'Elektroinstallation Küche',
    description: '',
    customerName: 'Stefan Hoffmann',
    location: 'Hannover-Nordstadt',
    dateLabel: 'In 3 Tagen',
    dateKey: dateKey(3),
    startsAtLabel: '08:00',
    endsAtLabel: '13:00',
    assignedMemberIds: ['tm-1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
]
