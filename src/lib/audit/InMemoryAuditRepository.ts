import type { AuditEntry, AuditRepository } from './AuditRepository'

/**
 * In-memory audit repository used in tests.
 *
 * Stores all entries in a plain array so tests can assert on the
 * exact set of audit records that were written during a workflow run.
 */
export class InMemoryAuditRepository implements AuditRepository {
  private entries: AuditEntry[] = []

  insertAuditEntry(entry: AuditEntry): void {
    this.entries.push(entry)
  }

  getEntries(): AuditEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }
}
