export interface OwnerNote {
  id: string
  jobId: string
  authoredBy: string
  body: string
  metadata: Record<string, unknown>
  /** Unix-ms timestamp. */
  createdAt: number
  /** Unix-ms timestamp. */
  updatedAt: number
}
