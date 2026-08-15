import type {
  ThreadArtifactRecord,
  ArtifactType,
  ThreadArtifactRepository,
} from '../threadArtifactRecord'

export class InMemoryThreadArtifactRepository implements ThreadArtifactRepository {
  private records: ThreadArtifactRecord[]
  private listeners: Set<() => void> = new Set()

  constructor(initial: ThreadArtifactRecord[] = []) {
    // Enforce uniqueness on (conversationId, artifactType) for offer/payment_phase
    // only. project / change_order / invoice are append-only (multiple per
    // conversation, keyed to a deterministic record id), so they are kept as-is —
    // collapsing them would drop sibling cards a multi-record seed expects.
    const seen = new Map<string, number>()
    const deduped: ThreadArtifactRecord[] = []
    for (const record of initial) {
      if (
        record.artifactType === 'project' ||
        record.artifactType === 'change_order' ||
        record.artifactType === 'invoice'
      ) {
        // Append-only artifact kinds: keep all of them
        deduped.push(record)
      } else {
        const key = `${record.conversationId}::${record.artifactType}`
        const existing = seen.get(key)
        if (existing !== undefined) {
          deduped[existing] = record
        } else {
          seen.set(key, deduped.length)
          deduped.push(record)
        }
      }
    }
    this.records = deduped
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getByConversationId(conversationId: string): ThreadArtifactRecord[] {
    return this.records.filter((r) => r.conversationId === conversationId)
  }

  getByConversationAndType(
    conversationId: string,
    type: ArtifactType
  ): ThreadArtifactRecord | undefined {
    return this.records.find(
      (r) => r.conversationId === conversationId && r.artifactType === type
    )
  }

  upsert(record: ThreadArtifactRecord): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === record.id)
    if (idx >= 0) {
      this.records[idx] = record
    } else {
      this.records.push(record)
    }
    this.notify()
    return Promise.resolve()
  }

  insert(record: ThreadArtifactRecord): Promise<void> {
    this.records.push(record)
    this.notify()
    return Promise.resolve()
  }

  getAll(): ThreadArtifactRecord[] {
    return [...this.records]
  }
}
