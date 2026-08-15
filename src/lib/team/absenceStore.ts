import {
  getAbsenceRepository,
  initializeAbsenceRepository,
} from './repository'
import type { Absence } from './absenceTypes'

export function getAbsences(): Absence[] {
  return getAbsenceRepository().getAll()
}

export function subscribeAbsences(listener: () => void): () => void {
  return getAbsenceRepository().subscribe(listener)
}

export function isAbsencesHydrated(): boolean {
  return getAbsenceRepository().isHydrated()
}

export function retryAbsencesHydration(): void {
  void initializeAbsenceRepository(true)
}
