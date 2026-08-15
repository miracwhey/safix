import type { CalendarEntry, CalendarEntryStatus } from '../calendarTypes'
import type { CalendarRepository, CalendarWriteOpts } from './CalendarRepository'

type Listener = () => void

export class InMemoryCalendarRepository implements CalendarRepository {
  private entries: CalendarEntry[]
  private readonly listeners = new Set<Listener>()

  /**
   * Defaults to empty — callers that want demo/seed data must pass it explicitly.
   * This keeps test instances isolated from app-level mock data.
   */
  constructor(initialData: CalendarEntry[] = []) {
    this.entries = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): CalendarEntry[] {
    return [...this.entries]
  }

  getById(id: string): CalendarEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  getByJobId(jobId: string): CalendarEntry | undefined {
    return this.entries.find((entry) => entry.jobId === jobId)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  add(entry: CalendarEntry, _opts?: CalendarWriteOpts): Promise<void> {
    this.entries = [entry, ...this.entries]
    this.notify()
    return Promise.resolve()
  }

  replace(entry: CalendarEntry, _opts?: CalendarWriteOpts): Promise<void> {
    this.entries = this.entries.map((e) => (e.id === entry.id ? entry : e))
    this.notify()
    return Promise.resolve()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateStatus(id: string, status: CalendarEntryStatus, _opts?: CalendarWriteOpts): Promise<void> {
    this.entries = this.entries.map((e) =>
      e.id === id ? { ...e, status, updatedAt: Date.now() } : e,
    )
    this.notify()
    return Promise.resolve()
  }

  updateScheduling(
    id: string,
    scheduling: { dateKey: string; startsAtLabel: string; endsAtLabel: string },
    _opts?: CalendarWriteOpts,
  ): Promise<void> {
    this.entries = this.entries.map((e) =>
      e.id === id
        ? {
            ...e,
            dateKey: scheduling.dateKey,
            startsAtLabel: scheduling.startsAtLabel,
            endsAtLabel: scheduling.endsAtLabel,
            updatedAt: Date.now(),
          }
        : e,
    )
    this.notify()
    return Promise.resolve()
  }
}
