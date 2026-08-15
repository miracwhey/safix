import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// provider_media migration schema validation
//
// Ensures the migration SQL matches what the service layer expects:
//   - providerMediaService.ts selects specific columns
//   - providerMediaTypes.ts defines ProviderMediaRow
//   - avatarUploadService.ts upserts with onConflict: 'provider_id,kind'
// ---------------------------------------------------------------------------

const migrationPath = resolve(
  __dirname,
  '../../supabase/migrations/20260317000014_provider_media.sql'
)
const migrationSql = readFileSync(migrationPath, 'utf-8')

describe('provider_media migration — schema alignment', () => {
  it('creates the provider_media table', () => {
    expect(migrationSql).toContain('CREATE TABLE')
    expect(migrationSql).toContain('public.provider_media')
  })

  // ProviderMediaRow columns from providerMediaTypes.ts:
  //   id, provider_id, kind, storage_path, public_url, caption, sort_order,
  //   created_at, updated_at
  it('includes all columns expected by ProviderMediaRow', () => {
    const requiredColumns = [
      'id',
      'provider_id',
      'kind',
      'storage_path',
      'public_url',
      'caption',
      'sort_order',
      'created_at',
      'updated_at',
    ]
    for (const col of requiredColumns) {
      expect(migrationSql).toContain(col)
    }
  })

  it('has a default for the id column (gen_random_uuid) so upserts without id work', () => {
    // avatarUploadService.ts upserts without an id — the DB must generate one
    expect(migrationSql).toMatch(/id\s+uuid\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/i)
  })

  it('provider_id is uuid (matches providers.id) with a foreign key reference', () => {
    expect(migrationSql).toMatch(/provider_id\s+uuid\s+NOT NULL\s+REFERENCES\s+public\.providers\(id\)/i)
  })

  // avatarUploadService.ts uses:
  //   { onConflict: 'provider_id,kind', ignoreDuplicates: false }
  // This requires a UNIQUE index or constraint on (provider_id, kind)
  it('has a unique index on (provider_id, kind) for the avatar upsert', () => {
    expect(migrationSql).toMatch(/UNIQUE INDEX/i)
    expect(migrationSql).toMatch(/provider_id, kind/i)
  })

  it('enables Row Level Security', () => {
    expect(migrationSql).toContain('ENABLE ROW LEVEL SECURITY')
  })

  it('has a SELECT policy for authenticated users (public profile data)', () => {
    expect(migrationSql).toMatch(/POLICY.*provider_media_select/i)
    expect(migrationSql).toContain("auth.role() = 'authenticated'")
  })

  it('has an INSERT policy restricted to the owning provider', () => {
    expect(migrationSql).toMatch(/POLICY.*provider_media_insert_own/i)
    expect(migrationSql).toContain('profile_id = auth.uid()')
  })

  it('has an UPDATE policy restricted to the owning provider', () => {
    expect(migrationSql).toMatch(/POLICY.*provider_media_update_own/i)
  })

  it('has a DELETE policy restricted to the owning provider', () => {
    expect(migrationSql).toMatch(/POLICY.*provider_media_delete_own/i)
  })

  // sort_order has a default so inserts that don't specify it still work
  it('sort_order has a default value', () => {
    expect(migrationSql).toMatch(/sort_order\s+integer\s+DEFAULT\s+\d/i)
  })

  // created_at / updated_at have defaults so server-generated timestamps work
  it('timestamp columns have defaults', () => {
    expect(migrationSql).toMatch(/created_at\s+timestamptz\s+DEFAULT/i)
    expect(migrationSql).toMatch(/updated_at\s+timestamptz\s+DEFAULT/i)
  })
})
