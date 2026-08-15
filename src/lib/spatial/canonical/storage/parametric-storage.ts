/**
 * Spatial · Canonical · Storage · parametric.json
 *
 * Reads + writes the parametric-blob for a canonical scene. Decision #2:
 * the blob lives in Supabase Storage, NOT embedded in a jsonb column. This
 * file is the only legal seam between `RoomScene` (in-memory) and the
 * persisted gzip+sha-prefixed bytes.
 *
 * Pipeline (write):
 *   1. JSON-Schema validate the document (raises SchemaValidationError).
 *   2. Stable-stringify (sorted keys) for deterministic content hashing.
 *   3. gzip via pako.
 *   4. SHA-256 the gzipped bytes (Web Crypto in browsers, Node ≥ 15).
 *   5. Caller uploads to Storage at `parametricStoragePath`.
 *
 * Pipeline (read): inverse, with optional schema_version migration.
 *
 * The exported helpers are pure (no Supabase client coupling). Day-8
 * `SupabaseSpatialSceneRepository` composes these with the Supabase
 * Storage SDK; tests compose them with the InMemory bucket helper below.
 */

import pako from 'pako'

import { validateParametricJsonSafe } from '../schema/ajv-validator.ts'
import {
  CURRENT_SCHEMA_VERSION,
  migrateParametricJson,
} from '../schema/version-migration.ts'
import { CanonicalError, SchemaValidationError } from '../types/errors.ts'

/** Wire-payload returned from {@link encodeParametricBlob}. */
export interface ParametricBlobWire {
  /** Gzip-compressed bytes of the stable-stringified JSON document. */
  bytes: Uint8Array
  /** SHA-256 of `bytes` (lowercase hex · 64 chars). */
  sha256: string
  /** Size of `bytes` (alias of `bytes.byteLength`). */
  sizeBytes: number
}

/** Decoded output of {@link decodeParametricBlob}. */
export interface DecodedParametricBlob {
  /** Migrated document at {@link CURRENT_SCHEMA_VERSION}. */
  document: Record<string, unknown>
  /** SHA-256 of the original (pre-decompression) bytes. */
  sha256: string
  /** True when the document was migrated to the current schema version. */
  migrated: boolean
}

/**
 * Validate, stable-stringify, gzip, and SHA-256 a parametric document. The
 * caller is responsible for uploading the bytes to Storage.
 */
export async function encodeParametricBlob(
  document: unknown,
): Promise<ParametricBlobWire> {
  const validation = validateParametricJsonSafe(document)
  if (!validation.valid) {
    throw new SchemaValidationError(validation.errors ?? [], 'parametric.json failed schema validation')
  }
  const json = stableStringify(document)
  const bytes = pako.gzip(json)
  const sha256 = await sha256Hex(bytes)
  return { bytes, sha256, sizeBytes: bytes.byteLength }
}

/**
 * Verify SHA, decompress, parse, and migrate a stored parametric blob.
 * Throws {@link CanonicalError} when the SHA does not match the expected
 * value (storage corruption / wrong content-address), and rethrows
 * {@link SchemaValidationError} when the migrated document still fails
 * schema validation.
 */
export async function decodeParametricBlob(
  bytes: Uint8Array,
  options?: { expectedSha256?: string },
): Promise<DecodedParametricBlob> {
  const sha256 = await sha256Hex(bytes)
  if (options?.expectedSha256 && options.expectedSha256 !== sha256) {
    throw new CanonicalError(
      'STORAGE_ERROR',
      `parametric blob SHA mismatch: expected ${options.expectedSha256}, got ${sha256}`,
    )
  }
  let json: string
  try {
    json = pako.ungzip(bytes, { to: 'string' })
  } catch (e) {
    throw new CanonicalError(
      'STORAGE_ERROR',
      `parametric blob decompression failed: ${(e as Error).message}`,
    )
  }
  let document: unknown
  try {
    document = JSON.parse(json)
  } catch (e) {
    throw new CanonicalError(
      'STORAGE_ERROR',
      `parametric blob JSON-parse failed: ${(e as Error).message}`,
    )
  }
  const prevVersion =
    document && typeof document === 'object' && 'schema_version' in document
      ? (document as { schema_version: unknown }).schema_version
      : undefined
  const migrated = migrateParametricJson(document)
  const wasMigrated = prevVersion !== CURRENT_SCHEMA_VERSION
  const validation = validateParametricJsonSafe(migrated)
  if (!validation.valid) {
    throw new SchemaValidationError(
      validation.errors ?? [],
      'migrated parametric.json failed schema validation',
    )
  }
  return { document: migrated, sha256, migrated: wasMigrated }
}

/**
 * Deterministic JSON-stringify: sorts object keys recursively. Required
 * because `JSON.stringify` preserves insertion-order, which produces
 * different SHA-256s for content-equal documents persisted from different
 * code paths (e.g. an in-memory build vs. one loaded from PG).
 *
 * Matches `JSON.stringify` semantics for `undefined`: a property whose
 * value is `undefined` is dropped from an object (and rendered as `null`
 * when it appears inside an array). Without this, optional fields like
 * `ValidationIssue.suggested_fix` produce `"key":undefined` token
 * sequences that the runtime `JSON.parse` then rejects on decode.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value
      .map((v) => (v === undefined ? 'null' : stableStringify(v)))
      .join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`,
  )
  return `{${parts.join(',')}}`
}

/** SHA-256 of a byte array, returned as lowercase hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Both browsers and Node ≥ 15 expose `crypto.subtle.digest`. Copy into a
  // fresh ArrayBuffer-backed Uint8Array so TS-strict accepts the
  // BufferSource argument (pako returns a `Uint8Array<ArrayBufferLike>`
  // which may be SharedArrayBuffer-backed in some build targets).
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const view = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0')
  }
  return out
}
