import type { TimeEntry } from '../timeEntryTypes'
import {
  TimeEntryActiveConflictError,
  TimeEntryNotFoundError,
  type TimeEntryCreateInput,
  type TimeEntryRepository,
  type TimeEntryUpdatePatch,
} from './TimeEntryRepository'

type Listener = () => void

let idCounter = 1
function genId(): string {
  return `te-mock-${idCounter++}`
}

/**
 * In-memory implementation of TimeEntryRepository.
 *
 * Faithfully simulates the unique-active-timer indices so workflow tests can
 * exercise the conflict paths without round-tripping to Supabase.
 */
export class InMemoryTimeEntryRepository implements TimeEntryRepository {
  private entries: TimeEntry[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // No-op: pre-seeded via constructor, callers may push fixtures via reset().
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

  getAll(): TimeEntry[] {
    return [...this.entries]
  }

  getById(id: string): TimeEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  async create(input: TimeEntryCreateInput): Promise<TimeEntry> {
    if (input.kind === 'job' && !input.jobId) {
      throw new Error('TimeEntry: kind="job" requires jobId')
    }
    if (input.kind === 'day' && input.jobId) {
      throw new Error('TimeEntry: kind="day" must not have jobId')
    }

    // Simulate the unique partial index for active timers
    const conflict = this.entries.find(
      (e) => e.memberId === input.memberId && e.kind === input.kind && e.status === 'active',
    )
    if (conflict) {
      throw new TimeEntryActiveConflictError(input.kind)
    }

    const now = new Date().toISOString()
    const entry: TimeEntry = {
      id: genId(),
      providerId: input.providerId,
      memberId: input.memberId,
      kind: input.kind,
      jobId: input.jobId,
      startedAt: input.startedAt,
      endedAt: null,
      durationMinutes: null,
      note: input.note ?? null,
      status: 'active',
      rejectedReason: null,
      rejectedBy: null,
      rejectedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.entries = [...this.entries, entry]
    this.notify()
    return entry
  }

  async update(id: string, patch: TimeEntryUpdatePatch): Promise<TimeEntry> {
    const existing = this.entries.find((e) => e.id === id)
    if (!existing) {
      throw new TimeEntryNotFoundError(id)
    }
    // Mirror the `time_entries_reject_stamp` server trigger so InMemory tests
    // observe the same `rejectedAt` semantics as the supabase repo.
    const transitioningToRejected = patch.status === 'rejected' && existing.status !== 'rejected'
    const transitioningOutOfRejected =
      patch.status !== undefined && patch.status !== 'rejected' && existing.status === 'rejected'
    const rejectedAt = transitioningToRejected
      ? new Date().toISOString()
      : transitioningOutOfRejected
        ? null
        : existing.rejectedAt
    const updated: TimeEntry = {
      ...existing,
      ...patch,
      rejectedAt,
      updatedAt: new Date().toISOString(),
    }
    this.entries = this.entries.map((e) => (e.id === id ? updated : e))
    this.notify()
    return updated
  }

  reset(): void {
    this.entries = []
    idCounter = 1
    this.notify()
  }

  /** Test helper: seeds the cache with arbitrary entries. */
  seed(entries: TimeEntry[]): void {
    this.entries = [...entries]
    this.notify()
  }
}
