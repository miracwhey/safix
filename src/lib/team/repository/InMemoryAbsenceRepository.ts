import type { Absence } from '../absenceTypes'
import {
  AbsenceNotFoundError,
  type AbsenceCreateInput,
  type AbsenceRepository,
  type AbsenceUpdatePatch,
} from './AbsenceRepository'

type Listener = () => void

let idCounter = 1
function genId(): string {
  return `abs-mock-${idCounter++}`
}

/**
 * In-memory implementation of AbsenceRepository.
 *
 * Used in tests + in-memory data source mode. No RLS simulation — callers
 * are trusted (workflow guards do the equivalent).
 */
export class InMemoryAbsenceRepository implements AbsenceRepository {
  private absences: Absence[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // No-op: pre-seeded via constructor or push fixtures via reset().
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Absence[] {
    return [...this.absences]
  }

  getById(id: string): Absence | undefined {
    return this.absences.find((a) => a.id === id)
  }

  async create(input: AbsenceCreateInput): Promise<Absence> {
    const now = new Date().toISOString()
    const row: Absence = {
      id: genId(),
      providerId: input.providerId,
      memberId: input.memberId,
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate,
      reasonNote: input.reasonNote ?? null,
      status: 'active',
      sickNoteRequested: false,
      sickNoteRequestedAt: null,
      sickNoteUrl: null,
      sickNoteSubmittedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.absences = [row, ...this.absences]
    this.notify()
    return row
  }

  async update(id: string, patch: AbsenceUpdatePatch): Promise<Absence> {
    const existing = this.absences.find((a) => a.id === id)
    if (!existing) throw new AbsenceNotFoundError(id)
    const next: Absence = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}),
      ...(patch.sickNoteRequested !== undefined
        ? { sickNoteRequested: patch.sickNoteRequested }
        : {}),
      ...(patch.sickNoteRequestedAt !== undefined
        ? { sickNoteRequestedAt: patch.sickNoteRequestedAt }
        : {}),
      ...(patch.sickNoteUrl !== undefined ? { sickNoteUrl: patch.sickNoteUrl } : {}),
      ...(patch.sickNoteSubmittedAt !== undefined
        ? { sickNoteSubmittedAt: patch.sickNoteSubmittedAt }
        : {}),
      updatedAt: new Date().toISOString(),
    }
    this.absences = this.absences.map((a) => (a.id === id ? next : a))
    this.notify()
    return next
  }

  reset(): void {
    this.absences = []
    this.notify()
  }
}
