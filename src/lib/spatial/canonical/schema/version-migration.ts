/**
 * Spatial · Canonical · Schema · Version-Migration
 *
 * Forward-compatible migration pipeline for `parametric.json`.
 *
 * V1 ships with `schema_version === '1.0'` and no historical versions to
 * migrate from; the registry below is the skeleton that future migrations
 * will plug into. Each migration is a pure function
 *
 *   `(prev: unknown) => unknown`
 *
 * that brings a document from `vN` to `vN+1`. The pipeline iterates them
 * in version order until the document reports the requested target.
 *
 * IMPORTANT: migrations are run BEFORE schema validation, so they may
 * accept slightly-loose inputs. They MUST emit a document that the
 * current `parametric-json-schema.ts` validates cleanly.
 */

export const CURRENT_SCHEMA_VERSION = '1.0'

type MigrationFn = (prev: unknown) => Record<string, unknown>

/**
 * Ordered list of migration steps. Each entry knows:
 *   - which version it READS (`from`)
 *   - which version it PRODUCES (`to`)
 *   - the migration function
 *
 * The runner walks the list in declaration order and picks up any step
 * whose `from` matches the document's current version.
 */
interface MigrationStep {
  from: string
  to: string
  migrate: MigrationFn
}

const MIGRATIONS: ReadonlyArray<MigrationStep> = [
  // V1 has no historical versions. Pre-V1 documents (if they ever existed)
  // would land here as e.g. { from: '0.9', to: '1.0', migrate: ... }.
]

/**
 * Options for {@link migrateParametricJson}.
 *
 * `assumeCurrent` opts in to the previous silent-default behaviour: when the
 * input document has no `schema_version`, treat it as the current version.
 * Default is `false` (H26 audit-fix): an undeclared version is an error,
 * because silently persisting a "current" document we never verified would
 * mask integration bugs at the worst possible moment.
 */
export interface MigrateOptions {
  assumeCurrent?: boolean
}

/**
 * Migrate `json` to {@link CURRENT_SCHEMA_VERSION} (or to the explicit
 * `targetVersion` argument, useful for tests).
 *
 * Throws if a step is missing for the document's reported version — better
 * to fail loudly than to silently persist a half-migrated document.
 *
 * H26 audit-fix: a missing `schema_version` is rejected by default; opt in
 * via `{ assumeCurrent: true }` only at deliberate test/seed sites.
 */
export function migrateParametricJson(
  json: unknown,
  targetVersion: string = CURRENT_SCHEMA_VERSION,
  options: MigrateOptions = {},
): Record<string, unknown> {
  if (!json || typeof json !== 'object') {
    throw new Error('migrateParametricJson: input is not an object')
  }
  let current = json as Record<string, unknown>
  if (typeof current.schema_version !== 'string') {
    if (options.assumeCurrent) {
      current = { ...current, schema_version: CURRENT_SCHEMA_VERSION }
    } else {
      throw new Error(
        'migrateParametricJson: input is missing `schema_version`. Pass { assumeCurrent: true } to opt into the legacy default.',
      )
    }
  }
  while (current.schema_version !== targetVersion) {
    const step = MIGRATIONS.find(s => s.from === current.schema_version)
    if (!step) {
      throw new Error(
        `migrateParametricJson: no migration from ${String(current.schema_version)} to ${targetVersion}`,
      )
    }
    current = step.migrate(current)
    if (current.schema_version !== step.to) {
      throw new Error(
        `migrateParametricJson: migration ${step.from}→${step.to} produced schema_version ${String(current.schema_version)}`,
      )
    }
  }
  return current
}

/** Test-only export so future migrations can be unit-tested in isolation. */
export const __MIGRATIONS_FOR_TESTS = MIGRATIONS
