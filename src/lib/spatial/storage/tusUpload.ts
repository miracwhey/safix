/**
 * Spatial Core · Block X.4 · TUS Resumable Upload
 *
 * Drop-in resumable uploader for scan assets larger than `TUS_THRESHOLD_BYTES`.
 * Smaller blobs continue to use the single-PUT path in `uploadScanAsset` —
 * the round-trip overhead of TUS creation + chunking is wasted for files
 * that fit in a single chunk.
 *
 * Supabase Storage exposes a TUS endpoint at:
 *
 *   {VITE_SUPABASE_URL}/storage/v1/upload/resumable
 *
 * Chunk size is **fixed at 6 MiB** by Supabase — any other value causes the
 * upload-protocol negotiation to fail. `tus-js-client` does not honour
 * server-suggested chunk sizes, so we set it explicitly.
 *
 * Auth: the user JWT goes in the Authorization header. `x-upsert: true`
 * mirrors the direct-PUT behaviour so a re-upload of the same path is
 * accepted (the storage RLS still gates that, and the SHA-keyed path means
 * a true re-scan never collides).
 *
 * Retry: `tus-js-client` resumes from the last persisted byte on
 * onError → start(). We pass an exponential backoff so a flaky cellular
 * link doesn't burn battery on tight retry loops.
 */

import { Upload } from 'tus-js-client'
import { supabase } from '../../supabase'

export const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024
/** Blobs smaller than this skip TUS and use a single PUT. */
export const TUS_THRESHOLD_BYTES = 5 * 1024 * 1024

export interface TusUploadArgs {
  bucket: string
  path: string
  blob: Blob
  contentType: string
  /** Mirrors the Supabase Storage `cacheControl` header — pass through. */
  cacheControl?: string
  onProgress?: (loaded: number, total: number) => void
  /** Aborts the in-flight upload when the caller decides to bail. */
  signal?: AbortSignal
}

export async function tusUploadBlob(args: TusUploadArgs): Promise<void> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw sessionError
  const accessToken = sessionData.session?.access_token
  if (!accessToken) {
    throw new Error('tusUploadBlob: no access token — caller must be authenticated')
  }
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''
  if (!supabaseUrl || !anonKey) {
    throw new Error('tusUploadBlob: VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing')
  }

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(args.blob, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-upsert': 'true',
        apikey: anonKey,
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: args.bucket,
        objectName: args.path,
        contentType: args.contentType,
        cacheControl: args.cacheControl ?? '3600',
      },
      chunkSize: TUS_CHUNK_SIZE_BYTES,
      onError: err => reject(err),
      onProgress: (loaded, total) => args.onProgress?.(loaded, total),
      onSuccess: () => resolve(),
    })

    if (args.signal) {
      const onAbort = () => {
        void upload.abort(true)
        reject(args.signal!.reason ?? new Error('aborted'))
      }
      if (args.signal.aborted) {
        onAbort()
      } else {
        args.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    upload.start()
  })
}
