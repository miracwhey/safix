import { describe, it, expect } from 'vitest'
import {
  rowToRequest,
  requestToRow,
} from '../../src/lib/corrections/repository/SupabaseCorrectionRepository'
import type { CorrectionRequest } from '../../src/lib/corrections'

describe('Block 7.2.3 — correction structured-fields mapping', () => {
  it('rowToRequest hydrates all four structured fields when present', () => {
    const row = {
      id: 'cr-1',
      provider_id: 'p1',
      worker_team_member_id: 'tm1',
      worker_profile_id: 'u1',
      calendar_entry_id: null,
      requested_date: null,
      kind: 'wrong_time',
      description: 'falsche Zeit',
      status: 'open',
      owner_note: null,
      field: 'Arbeitszeit Mo 28.04.',
      current_value: '6h',
      proposed_value: '8h',
      reason: 'Foto-Zeitstempel zeigt 7:30–15:30',
      created_at: 1,
      updated_at: 1,
    }
    const req = rowToRequest(row)
    expect(req.field).toBe('Arbeitszeit Mo 28.04.')
    expect(req.currentValue).toBe('6h')
    expect(req.proposedValue).toBe('8h')
    expect(req.reason).toBe('Foto-Zeitstempel zeigt 7:30–15:30')
  })

  it('rowToRequest omits structured-field keys when row stores null', () => {
    const row = {
      id: 'cr-2',
      provider_id: 'p1',
      worker_team_member_id: 'tm1',
      worker_profile_id: 'u1',
      calendar_entry_id: null,
      requested_date: null,
      kind: 'other',
      description: 'allgemein',
      status: 'open',
      owner_note: null,
      field: null,
      current_value: null,
      proposed_value: null,
      reason: null,
      created_at: 1,
      updated_at: 1,
    }
    const req = rowToRequest(row)
    expect(req.field).toBeUndefined()
    expect(req.currentValue).toBeUndefined()
    expect(req.proposedValue).toBeUndefined()
    expect(req.reason).toBeUndefined()
  })

  it('requestToRow uses snake_case keys + nulls for absent structured fields', () => {
    const r: CorrectionRequest = {
      id: 'cr-3',
      providerId: 'p1',
      workerTeamMemberId: 'tm1',
      workerProfileId: 'u1',
      kind: 'wrong_time',
      description: 'falsche Zeit',
      status: 'open',
      createdAt: 1,
      updatedAt: 1,
      field: 'X',
      currentValue: 'A',
    }
    const row = requestToRow(r) as Record<string, unknown>
    expect(row.field).toBe('X')
    expect(row.current_value).toBe('A')
    expect(row.proposed_value).toBeNull()
    expect(row.reason).toBeNull()
  })
})
