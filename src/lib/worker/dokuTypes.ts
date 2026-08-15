/**
 * WorkerDoku Domain-Types · Block C.2
 *
 * Spiegelt das Schema aus den Migrationen `20260508000002_job_photos.sql`
 * und `20260508000003_job_reports.sql`. Repository-Layer maps DB-Rows
 * (snake_case timestamptz) auf diese Domain-Types (camelCase + unix-ms),
 * damit UI und Workflow gegen ein konsistentes Datum/ID-Format arbeiten.
 *
 * Storage-Path-Konvention für Fotos: `jobs/{job_id}/{client_uuid}.jpg`.
 * `client_uuid` wird vom Capture-Service generiert (UUID v4) und ist der
 * Idempotenz-Key gegen Offline-Queue-Replay nach Reconnect.
 */

export interface JobPhoto {
  id: string
  jobId: string
  providerId: string
  uploadedBy: string
  /** Path innerhalb des privaten worker-doku-photos Buckets. */
  storagePath: string
  /** UUID v4, vom Client generiert für Idempotenz. */
  clientUuid: string
  widthPx?: number
  heightPx?: number
  sizeBytes?: number
  /** Unix-ms timestamp. */
  createdAt: number
}

export interface JobReport {
  id: string
  jobId: string
  providerId: string
  authoredBy: string
  body: string
  /** JSON-Payload für zukünftige strukturierte Felder (Material, Mängel). */
  metadata: Record<string, unknown>
  /** Unix-ms timestamp. */
  createdAt: number
  /** Unix-ms timestamp. */
  updatedAt: number
}

/**
 * Eingang in den Capture-Service. Worker startet die Camera, der Service
 * sammelt diese Felder aus dem Aufruf-Kontext (caseId → CalendarEntry →
 * jobId, providerId aus dem Worker-Profil).
 */
export interface CapturePhotoInput {
  jobId: string
  providerId: string
}

/**
 * Result eines erfolgreichen Capture-Flows. Caller bekommt genug Info,
 * um Optimistic-Update + UI-Refresh zu fahren.
 */
export interface CapturePhotoResult {
  photo: JobPhoto
  /** True wenn das Foto durch die preUploadPipeline neu encoded wurde
   *  (= EXIF gestripped). False wenn keine Komprimierung möglich war
   *  (z.B. Test-Env ohne Canvas) — Caller kann dann optional warnen. */
  wasReencoded: boolean
  diagnostics: {
    originalSize: number
    finalSize: number
  }
}

export interface SubmitReportInput {
  jobId: string
  providerId: string
  body: string
  metadata?: Record<string, unknown>
}
