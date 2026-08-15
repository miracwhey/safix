import { describe, it, expect } from 'vitest'
import {
  deriveRotationDisabledReason,
  deriveRotationConfirmationCopy,
} from '../../src/lib/company/codeRotationSelectors'
import type { CodeAuditEntry } from '../../src/lib/company/codeRotation'

function entry(rotatedAt: string, id = `audit-${rotatedAt}`): CodeAuditEntry {
  return {
    id,
    providerId: 'p',
    oldCodeId: 'old',
    newCodeId: 'new',
    rotatedBy: 'u',
    rotatedAt,
    reason: null,
  }
}

describe('deriveRotationDisabledReason', () => {
  const NOW = new Date('2026-05-01T12:00:00Z')

  it('returns null when no rotations occurred', () => {
    expect(deriveRotationDisabledReason([], NOW)).toBeNull()
  })

  it('returns null below 5 rotations within 24h', () => {
    const audit = Array.from({ length: 4 }, (_, i) =>
      entry(new Date(NOW.getTime() - i * 60 * 60 * 1000).toISOString(), `a${i}`),
    )
    expect(deriveRotationDisabledReason(audit, NOW)).toBeNull()
  })

  it('returns rate_limit at exactly 5 rotations within 24h', () => {
    const audit = Array.from({ length: 5 }, (_, i) =>
      entry(new Date(NOW.getTime() - i * 60 * 60 * 1000).toISOString(), `a${i}`),
    )
    expect(deriveRotationDisabledReason(audit, NOW)).toBe('rate_limit')
  })

  it('ignores rotations older than 24h', () => {
    const audit = [
      entry(new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString(), 'recent'),
      ...Array.from({ length: 4 }, (_, i) =>
        entry(new Date(NOW.getTime() - (25 + i) * 60 * 60 * 1000).toISOString(), `old${i}`),
      ),
    ]
    expect(deriveRotationDisabledReason(audit, NOW)).toBeNull()
  })
})

describe('deriveRotationConfirmationCopy', () => {
  it('uses singular for one member', () => {
    const copy = deriveRotationConfirmationCopy(1)
    expect(copy.body).toContain('Dein 1 Mitarbeiter')
  })

  it('uses plural for many members', () => {
    const copy = deriveRotationConfirmationCopy(7)
    expect(copy.body).toContain('Deine 7 Mitarbeiter')
  })

  it('uses zero-state copy for no members', () => {
    const copy = deriveRotationConfirmationCopy(0)
    expect(copy.body).toContain('niemand beigetreten')
  })
})
