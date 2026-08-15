import type { CorrectionRequest } from '../types'

export interface CorrectionRepository {
  initialize(): Promise<void>
  isHydrated(): boolean

  getAll(): CorrectionRequest[]
  getById(id: string): CorrectionRequest | undefined

  add(request: CorrectionRequest): Promise<void>
  update(id: string, updater: (r: CorrectionRequest) => CorrectionRequest): Promise<void>

  subscribe(listener: () => void): () => void
}
