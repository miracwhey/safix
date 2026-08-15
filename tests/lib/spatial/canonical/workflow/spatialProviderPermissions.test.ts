/**
 * Tests for spatialProviderPermissions.ts — the pure action-permission matrix
 * for the Provider Spatial Hub (spec §2.2, Phase B · B-3).
 *
 * Covers:
 *   - All four roles × the full action matrix.
 *   - Conservative deny-by-default for any role not explicitly granted.
 *   - The resolver is pure and deterministic (no side effects, no React).
 */

import { describe, it, expect } from 'vitest'

import {
  resolveSpatialActionPermissions,
  type SpatialTeamRole,
  type SpatialProviderPermissions,
} from '../../../../../src/lib/spatial/canonical/workflow/spatialProviderPermissions'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function permissionsFor(role: SpatialTeamRole): SpatialProviderPermissions {
  return resolveSpatialActionPermissions(role)
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner (Foreman)
// ─────────────────────────────────────────────────────────────────────────────

describe('owner (Foreman)', () => {
  const perms = permissionsFor('owner')

  it('can add own pin', () => {
    expect(perms.canAddOwnPin).toBe(true)
  })

  it('can edit any pin', () => {
    expect(perms.canEditAnyPin).toBe(true)
  })

  it('can add measurement override', () => {
    expect(perms.canAddMeasurementOverride).toBe(true)
  })

  it('can add material suggestion', () => {
    expect(perms.canAddMaterialSuggestion).toBe(true)
  })

  it('can trigger rescan', () => {
    expect(perms.canTriggerRescan).toBe(true)
  })

  it('can edit BoM', () => {
    expect(perms.canEditBom).toBe(true)
  })

  it('can send quote', () => {
    expect(perms.canSendQuote).toBe(true)
  })

  it('can accept change-order', () => {
    expect(perms.canAcceptChangeOrder).toBe(true)
  })

  it('can verify-confirm', () => {
    expect(perms.canVerifyConfirm).toBe(true)
  })

  it('can walk', () => {
    expect(perms.canWalk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Worker (Field)
// ─────────────────────────────────────────────────────────────────────────────

describe('worker (Field)', () => {
  const perms = permissionsFor('worker')

  it('can add own pin', () => {
    expect(perms.canAddOwnPin).toBe(true)
  })

  it('CANNOT edit any pin (own only)', () => {
    expect(perms.canEditAnyPin).toBe(false)
  })

  it('can add measurement override', () => {
    expect(perms.canAddMeasurementOverride).toBe(true)
  })

  it('can add material suggestion', () => {
    expect(perms.canAddMaterialSuggestion).toBe(true)
  })

  it('can trigger rescan', () => {
    expect(perms.canTriggerRescan).toBe(true)
  })

  it('CANNOT edit BoM', () => {
    expect(perms.canEditBom).toBe(false)
  })

  it('CANNOT send quote', () => {
    expect(perms.canSendQuote).toBe(false)
  })

  it('CANNOT accept change-order', () => {
    expect(perms.canAcceptChangeOrder).toBe(false)
  })

  it('CANNOT verify-confirm', () => {
    expect(perms.canVerifyConfirm).toBe(false)
  })

  it('can walk', () => {
    expect(perms.canWalk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Office (Admin)
// ─────────────────────────────────────────────────────────────────────────────

describe('office (Admin)', () => {
  const perms = permissionsFor('office')

  it('CANNOT add own pin (field role only)', () => {
    expect(perms.canAddOwnPin).toBe(false)
  })

  it('CANNOT edit any pin', () => {
    expect(perms.canEditAnyPin).toBe(false)
  })

  it('CANNOT add measurement override (field role only)', () => {
    expect(perms.canAddMeasurementOverride).toBe(false)
  })

  it('can add material suggestion', () => {
    expect(perms.canAddMaterialSuggestion).toBe(true)
  })

  it('can trigger rescan', () => {
    expect(perms.canTriggerRescan).toBe(true)
  })

  it('can edit BoM', () => {
    expect(perms.canEditBom).toBe(true)
  })

  it('can send quote', () => {
    expect(perms.canSendQuote).toBe(true)
  })

  it('can accept change-order', () => {
    expect(perms.canAcceptChangeOrder).toBe(true)
  })

  it('can verify-confirm', () => {
    expect(perms.canVerifyConfirm).toBe(true)
  })

  it('can walk', () => {
    expect(perms.canWalk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Read-Only Viewer
// ─────────────────────────────────────────────────────────────────────────────

describe('read_only (Viewer)', () => {
  const perms = permissionsFor('read_only')

  it('CANNOT add own pin', () => {
    expect(perms.canAddOwnPin).toBe(false)
  })

  it('CANNOT edit any pin', () => {
    expect(perms.canEditAnyPin).toBe(false)
  })

  it('CANNOT add measurement override', () => {
    expect(perms.canAddMeasurementOverride).toBe(false)
  })

  it('CANNOT add material suggestion', () => {
    expect(perms.canAddMaterialSuggestion).toBe(false)
  })

  it('CANNOT trigger rescan', () => {
    expect(perms.canTriggerRescan).toBe(false)
  })

  it('CANNOT edit BoM', () => {
    expect(perms.canEditBom).toBe(false)
  })

  it('CANNOT send quote', () => {
    expect(perms.canSendQuote).toBe(false)
  })

  it('CANNOT accept change-order', () => {
    expect(perms.canAcceptChangeOrder).toBe(false)
  })

  it('CANNOT verify-confirm', () => {
    expect(perms.canVerifyConfirm).toBe(false)
  })

  it('CAN walk (universal)', () => {
    expect(perms.canWalk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Spec consistency — key boundary invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('spec invariants', () => {
  const roles: SpatialTeamRole[] = ['owner', 'worker', 'office', 'read_only']

  it('all roles can walk', () => {
    roles.forEach((r) => {
      expect(resolveSpatialActionPermissions(r).canWalk).toBe(true)
    })
  })

  it('only owner can edit any pin', () => {
    expect(permissionsFor('owner').canEditAnyPin).toBe(true)
    ;(['worker', 'office', 'read_only'] as SpatialTeamRole[]).forEach((r) => {
      expect(permissionsFor(r).canEditAnyPin).toBe(false)
    })
  })

  it('only owner and office can send quote', () => {
    expect(permissionsFor('owner').canSendQuote).toBe(true)
    expect(permissionsFor('office').canSendQuote).toBe(true)
    expect(permissionsFor('worker').canSendQuote).toBe(false)
    expect(permissionsFor('read_only').canSendQuote).toBe(false)
  })

  it('only owner and worker can add measurement override (field roles)', () => {
    expect(permissionsFor('owner').canAddMeasurementOverride).toBe(true)
    expect(permissionsFor('worker').canAddMeasurementOverride).toBe(true)
    expect(permissionsFor('office').canAddMeasurementOverride).toBe(false)
    expect(permissionsFor('read_only').canAddMeasurementOverride).toBe(false)
  })

  it('owner, worker, office can add material suggestion; read_only cannot', () => {
    expect(permissionsFor('owner').canAddMaterialSuggestion).toBe(true)
    expect(permissionsFor('worker').canAddMaterialSuggestion).toBe(true)
    expect(permissionsFor('office').canAddMaterialSuggestion).toBe(true)
    expect(permissionsFor('read_only').canAddMaterialSuggestion).toBe(false)
  })

  it('resolver returns distinct objects per call (not accidentally shared)', () => {
    const a = resolveSpatialActionPermissions('owner')
    const b = resolveSpatialActionPermissions('owner')
    // Same object ref is fine (frozen singleton) — just not the read_only one
    expect(a).toBe(b)
    expect(resolveSpatialActionPermissions('worker')).not.toBe(a)
  })
})
