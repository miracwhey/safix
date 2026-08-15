import { InMemoryAuditRepository } from './InMemoryAuditRepository'
import type { AuditRepository } from './AuditRepository'

let activeRepository: AuditRepository = new InMemoryAuditRepository()

export function getAuditRepository(): AuditRepository {
  return activeRepository
}

export function setAuditRepository(repository: AuditRepository): void {
  activeRepository = repository
}
