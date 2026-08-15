/**
 * Workflow-layer RBAC guard tests — `spatialEditPermissions.ts` (Block 2.10).
 *
 * Covers the full role × variant matrix, the role→writable-variant mapping,
 * the immutable-variant rule, and — critically — provider spy-prevention
 * (provider A may never write provider B's annotation layer).
 */
import { describe, it, expect } from 'vitest'

import {
  SpatialEditPermissionError,
  assertCanWriteVariant,
  canWriteVariant,
  classifyVariantAccess,
  isImmutableVariant,
  isJobFinalVariant,
  isProviderAnnotationsVariant,
  providerUserIdOfVariant,
  resolveWritableVariantId,
  type SpatialEditScene,
  type SpatialEditUser,
} from '../../../src/lib/spatial/workflow/spatialEditPermissions'
import {
  STANDARD_VARIANTS,
  providerAnnotationsVariantId,
  jobFinalVariantId,
} from '../../../src/lib/spatial/canonical/types/variants'

// ── Fixtures ───────────────────────────────────────────────────────────────

const CUSTOMER: SpatialEditUser = { userId: 'cust-1', role: 'customer', isOperator: false }
const PROVIDER_A: SpatialEditUser = { userId: 'prov-A', role: 'craftsman', isOperator: false }
const PROVIDER_B: SpatialEditUser = { userId: 'prov-B', role: 'craftsman', isOperator: false }
const OPERATOR: SpatialEditUser = { userId: 'op-1', role: 'craftsman', isOperator: true }
const SIGNED_OUT: SpatialEditUser = { userId: null, role: null, isOperator: false }

const BASE = STANDARD_VARIANTS.BASE_ROOMPLAN
const CUSTOMER_VARIANT = STANDARD_VARIANTS.CUSTOMER_CORRECTIONS
const OPERATOR_VARIANT = STANDARD_VARIANTS.OPERATOR_REVIEW
const PROVIDER_A_VARIANT = providerAnnotationsVariantId('prov-A')
const PROVIDER_B_VARIANT = providerAnnotationsVariantId('prov-B')
const JOB_FINAL = jobFinalVariantId('job-9')

const ALL_VARIANTS = [
  BASE,
  CUSTOMER_VARIANT,
  PROVIDER_A_VARIANT,
  PROVIDER_B_VARIANT,
  OPERATOR_VARIANT,
  JOB_FINAL,
]
const SCENE: SpatialEditScene = { variantIds: ALL_VARIANTS }

// ── Variant classification ─────────────────────────────────────────────────

describe('variant classification', () => {
  it('recognises provider-annotations variants', () => {
    expect(isProviderAnnotationsVariant(PROVIDER_A_VARIANT)).toBe(true)
    expect(isProviderAnnotationsVariant(CUSTOMER_VARIANT)).toBe(false)
    expect(isProviderAnnotationsVariant(BASE)).toBe(false)
    // empty user-id segment must not match
    expect(isProviderAnnotationsVariant('provider__annotations')).toBe(false)
  })

  it('recognises job-final variants', () => {
    expect(isJobFinalVariant(JOB_FINAL)).toBe(true)
    expect(isJobFinalVariant(BASE)).toBe(false)
    expect(isJobFinalVariant('job__final')).toBe(false)
  })

  it('extracts the owning provider user-id', () => {
    expect(providerUserIdOfVariant(PROVIDER_A_VARIANT)).toBe('prov-A')
    expect(providerUserIdOfVariant(PROVIDER_B_VARIANT)).toBe('prov-B')
    expect(providerUserIdOfVariant(CUSTOMER_VARIANT)).toBeNull()
  })

  it('marks base + job-final as immutable, others as not', () => {
    expect(isImmutableVariant(BASE)).toBe(true)
    expect(isImmutableVariant(JOB_FINAL)).toBe(true)
    expect(isImmutableVariant(CUSTOMER_VARIANT)).toBe(false)
    expect(isImmutableVariant(PROVIDER_A_VARIANT)).toBe(false)
    expect(isImmutableVariant(OPERATOR_VARIANT)).toBe(false)
  })
})

// ── resolveWritableVariantId — role → variant mapping ──────────────────────

describe('resolveWritableVariantId', () => {
  it('customer → customer_corrections', () => {
    expect(resolveWritableVariantId(CUSTOMER)).toBe(CUSTOMER_VARIANT)
  })

  it('provider → own provider_{id}_annotations', () => {
    expect(resolveWritableVariantId(PROVIDER_A)).toBe(PROVIDER_A_VARIANT)
    expect(resolveWritableVariantId(PROVIDER_B)).toBe(PROVIDER_B_VARIANT)
  })

  it('operator → operator_review (operator flag wins over role)', () => {
    expect(resolveWritableVariantId(OPERATOR)).toBe(OPERATOR_VARIANT)
  })

  it('signed-out user → null', () => {
    expect(resolveWritableVariantId(SIGNED_OUT)).toBeNull()
  })

  it('user with no recognised role → null', () => {
    expect(
      resolveWritableVariantId({ userId: 'x', role: null, isOperator: false }),
    ).toBeNull()
  })
})

// ── canWriteVariant — full role × variant matrix ───────────────────────────

describe('canWriteVariant — role × variant matrix', () => {
  const cases: Array<{ user: SpatialEditUser; name: string; allowed: string[] }> = [
    { user: CUSTOMER, name: 'customer', allowed: [CUSTOMER_VARIANT] },
    { user: PROVIDER_A, name: 'provider A', allowed: [PROVIDER_A_VARIANT] },
    { user: PROVIDER_B, name: 'provider B', allowed: [PROVIDER_B_VARIANT] },
    { user: OPERATOR, name: 'operator', allowed: [OPERATOR_VARIANT] },
    { user: SIGNED_OUT, name: 'signed-out', allowed: [] },
  ]

  for (const { user, name, allowed } of cases) {
    for (const variant of ALL_VARIANTS) {
      const shouldAllow = allowed.includes(variant)
      it(`${name} ${shouldAllow ? 'CAN' : 'cannot'} write ${variant}`, () => {
        expect(canWriteVariant(user, SCENE, variant)).toBe(shouldAllow)
      })
    }
  }

  it('nobody can write the immutable base layer', () => {
    expect(canWriteVariant(CUSTOMER, SCENE, BASE)).toBe(false)
    expect(canWriteVariant(PROVIDER_A, SCENE, BASE)).toBe(false)
    expect(canWriteVariant(OPERATOR, SCENE, BASE)).toBe(false)
  })

  it('nobody can write a sealed job-final layer', () => {
    expect(canWriteVariant(CUSTOMER, SCENE, JOB_FINAL)).toBe(false)
    expect(canWriteVariant(PROVIDER_A, SCENE, JOB_FINAL)).toBe(false)
    expect(canWriteVariant(OPERATOR, SCENE, JOB_FINAL)).toBe(false)
  })
})

// ── Spy-prevention (CD-7) ──────────────────────────────────────────────────

describe('provider spy-prevention', () => {
  it('provider A cannot write provider B annotations', () => {
    expect(canWriteVariant(PROVIDER_A, SCENE, PROVIDER_B_VARIANT)).toBe(false)
  })

  it('provider B cannot write provider A annotations', () => {
    expect(canWriteVariant(PROVIDER_B, SCENE, PROVIDER_A_VARIANT)).toBe(false)
  })

  it('assertCanWriteVariant flags a cross-provider write as provider_spy', () => {
    expect(() => assertCanWriteVariant(PROVIDER_A, SCENE, PROVIDER_B_VARIANT)).toThrow(
      SpatialEditPermissionError,
    )
    try {
      assertCanWriteVariant(PROVIDER_A, SCENE, PROVIDER_B_VARIANT)
    } catch (e) {
      expect(e).toBeInstanceOf(SpatialEditPermissionError)
      expect((e as SpatialEditPermissionError).code).toBe('provider_spy')
    }
  })

  it('a provider CAN write its own annotation layer', () => {
    expect(() => assertCanWriteVariant(PROVIDER_A, SCENE, PROVIDER_A_VARIANT)).not.toThrow()
  })
})

// ── assertCanWriteVariant — precise reason codes ───────────────────────────

describe('assertCanWriteVariant — reason codes', () => {
  it('signed-out → no_user', () => {
    try {
      assertCanWriteVariant(SIGNED_OUT, SCENE, CUSTOMER_VARIANT)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SpatialEditPermissionError).code).toBe('no_user')
    }
  })

  it('immutable variant → variant_read_only (checked before role-mismatch)', () => {
    try {
      assertCanWriteVariant(CUSTOMER, SCENE, BASE)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SpatialEditPermissionError).code).toBe('variant_read_only')
    }
    // job-final is immutable for EVERY role — the immutable gate fires first.
    try {
      assertCanWriteVariant(PROVIDER_A, SCENE, JOB_FINAL)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SpatialEditPermissionError).code).toBe('variant_read_only')
    }
  })

  it('customer → operator layer → variant_role_mismatch', () => {
    try {
      assertCanWriteVariant(CUSTOMER, SCENE, OPERATOR_VARIANT)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SpatialEditPermissionError).code).toBe('variant_role_mismatch')
    }
  })

  it('role with no writable layer → no_writable_variant', () => {
    const roleless: SpatialEditUser = { userId: 'x', role: null, isOperator: false }
    try {
      assertCanWriteVariant(roleless, SCENE, CUSTOMER_VARIANT)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SpatialEditPermissionError).code).toBe('no_writable_variant')
    }
  })

  it('the role-correct write passes silently', () => {
    expect(() => assertCanWriteVariant(CUSTOMER, SCENE, CUSTOMER_VARIANT)).not.toThrow()
    expect(() => assertCanWriteVariant(OPERATOR, SCENE, OPERATOR_VARIANT)).not.toThrow()
  })
})

// ── classifyVariantAccess — drives the VariantSwitcher UI ──────────────────

describe('classifyVariantAccess', () => {
  it('a user’s own writable variant is "writable", everything else "read_only"', () => {
    expect(classifyVariantAccess(CUSTOMER, SCENE, CUSTOMER_VARIANT)).toBe('writable')
    expect(classifyVariantAccess(CUSTOMER, SCENE, BASE)).toBe('read_only')
    expect(classifyVariantAccess(CUSTOMER, SCENE, PROVIDER_A_VARIANT)).toBe('read_only')

    expect(classifyVariantAccess(PROVIDER_A, SCENE, PROVIDER_A_VARIANT)).toBe('writable')
    expect(classifyVariantAccess(PROVIDER_A, SCENE, PROVIDER_B_VARIANT)).toBe('read_only')

    expect(classifyVariantAccess(OPERATOR, SCENE, OPERATOR_VARIANT)).toBe('writable')
    expect(classifyVariantAccess(SIGNED_OUT, SCENE, CUSTOMER_VARIANT)).toBe('read_only')
  })
})
