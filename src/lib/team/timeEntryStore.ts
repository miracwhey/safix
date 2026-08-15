import {
  getTimeEntryRepository,
  initializeTimeEntryRepository,
} from './repository'
import type { TimeEntry } from './timeEntryTypes'

export function getTimeEntries(): TimeEntry[] {
  return getTimeEntryRepository().getAll()
}

export function subscribeTimeEntries(listener: () => void): () => void {
  return getTimeEntryRepository().subscribe(listener)
}

export function isTimeEntriesHydrated(): boolean {
  return getTimeEntryRepository().isHydrated()
}

export function retryTimeEntriesHydration(): void {
  void initializeTimeEntryRepository(true)
}
