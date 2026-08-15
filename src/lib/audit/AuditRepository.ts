export interface AuditEntry {
  operatorId: string
  actionType: string
  entityType: string
  entityId?: string
  metadata?: Record<string, unknown>
}

export interface AuditRepository {
  insertAuditEntry(entry: AuditEntry): void
}
