/**
 * Spatial · Canonical · Schema · AJV-Validator
 *
 * Compiles the `parametric.json` schema once at module-load and exports
 * the bound validator. Callers should treat the validator as the
 * single-source-of-truth for "is this document well-formed".
 *
 * The validator instance is cached at module level — `ajv.compile` is
 * O(schema-size) and invariant once the schema is fixed.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

import { PARAMETRIC_JSON_SCHEMA } from './parametric-json-schema.ts'

const ajv = new Ajv({
  allErrors: true,
})

/**
 * Compiled validator function for the parametric.json document shape.
 *
 * Usage:
 *
 *   const valid = validateParametricJson(json)
 *   if (!valid) {
 *     // validateParametricJson.errors contains structured details
 *   }
 *
 * Always call `validateParametricJson.errors` immediately after a failed
 * call — ajv reuses the `errors` field on each call.
 */
export const validateParametricJson: ValidateFunction =
  ajv.compile(PARAMETRIC_JSON_SCHEMA)

/**
 * Walk a value and collect the path of every non-finite number
 * (`NaN` / `±Infinity`).
 *
 * CD-3 (hardening): ajv's `type: 'number'` ACCEPTS `NaN` and `Infinity`
 * because `typeof NaN === 'number'`. A coordinate corrupted to a non-finite
 * value in an in-memory document (one built by the bridge, not produced by
 * `JSON.parse`, which cannot encode them) would therefore pass schema
 * validation and reach the renderer as broken geometry. This walker runs
 * BEFORE `validateParametricJson` in {@link validateParametricJsonSafe} to
 * close that gap.
 *
 * Returns a list of `/`-joined paths; an empty list means all-finite.
 */
export function nanInfinityWalker(value: unknown, path = ''): string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [path === '' ? '(root)' : path]
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) => nanInfinityWalker(entry, `${path}/${i}`))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, entry]) => nanInfinityWalker(entry, `${path}/${key}`),
    )
  }
  return []
}

/**
 * Convenience wrapper that returns a discriminated result instead of
 * mutating a global. Useful in pipelines that prefer not to reach into
 * ajv's mutable `.errors`.
 *
 * Runs the {@link nanInfinityWalker} non-finite guard first (CD-3) — a
 * document with a `NaN` / `Infinity` number is rejected before ajv ever
 * sees it.
 */
export function validateParametricJsonSafe(value: unknown): {
  valid: boolean
  errors: typeof validateParametricJson.errors
} {
  const nonFinite = nanInfinityWalker(value)
  if (nonFinite.length > 0) {
    const errors = nonFinite.map(instancePath => ({
      keyword: 'finite',
      instancePath,
      dataPath: instancePath,
      schemaPath: '#/nanInfinityWalker',
      params: {},
      message: 'must be a finite number (NaN / Infinity rejected)',
    })) as unknown as ErrorObject[]
    return { valid: false, errors }
  }
  const valid = validateParametricJson(value) as boolean
  return { valid, errors: valid ? null : validateParametricJson.errors ?? null }
}

/**
 * Re-export the underlying ajv instance for tests + advanced consumers.
 * Production code should prefer `validateParametricJson`.
 */
export { ajv }
