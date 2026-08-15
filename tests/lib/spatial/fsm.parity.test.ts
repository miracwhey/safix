/**
 * Parity test: the TS `ALLOWED_SCAN_TRANSITIONS` set must match the
 * `scan_status_transition_allowed` rows seeded by
 * `supabase/migrations/20260518000005_scan_fsm_hardening.sql`.
 *
 * Parses the migration file at test-time so the source of truth stays in
 * SQL. If you add a transition to the SQL VALUES list, this test will fail
 * until you also add it to fsm.ts (and vice versa).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ALLOWED_SCAN_TRANSITIONS } from '../../../src/lib/spatial'

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../supabase/migrations/20260518000005_scan_fsm_hardening.sql',
)

/** Extracts `('from', 'to')` pairs from the seed INSERT in the migration. */
function parseDbTransitions(): Set<string> {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  const insertBlock = sql.match(
    /INSERT INTO public\.scan_status_transition_allowed \(from_status, to_status\) VALUES\s*([\s\S]+?)ON CONFLICT/,
  )
  if (!insertBlock) throw new Error('Could not find scan_status_transition_allowed seed block.')
  const tupleRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g
  const pairs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = tupleRe.exec(insertBlock[1])) !== null) {
    pairs.add(`${m[1]}->${m[2]}`)
  }
  return pairs
}

describe('Scan FSM parity (TS ↔ migration seed)', () => {
  it('every TS-allowed transition exists in the migration seed', () => {
    const dbPairs = parseDbTransitions()
    const missingInDb = [...ALLOWED_SCAN_TRANSITIONS].filter(p => !dbPairs.has(p))
    expect(missingInDb).toEqual([])
  })

  it('every migration-seeded transition exists in the TS set', () => {
    const dbPairs = parseDbTransitions()
    const missingInTs = [...dbPairs].filter(p => !ALLOWED_SCAN_TRANSITIONS.has(p as never))
    expect(missingInTs).toEqual([])
  })

  it('the seed has the expected total edge count (sanity)', () => {
    expect(parseDbTransitions().size).toBe(ALLOWED_SCAN_TRANSITIONS.size)
  })
})
