// @vitest-environment jsdom
/**
 * Render tests for the Block-2.9 `VariantSwitcher`.
 *
 * Covers: the Quick-Pill shows the active variant, the sheet lists every
 * variant, the pencil/eye affordance is role-derived (writable vs read-only),
 * and selecting a row calls `onSelect`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../src/lib/supabase', () => ({ supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } } }))

import { VariantSwitcher } from '../../../src/components/spatial/edit/VariantSwitcher'
import { useCanonicalSceneStore } from '../../../src/lib/spatial/canonical/store/sceneStore'
import {
  STANDARD_VARIANTS,
  providerAnnotationsVariantId,
  type Variant,
} from '../../../src/lib/spatial/canonical/types/variants'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
  mockOwnerSession,
} from '../../helpers/mockSession'

const PROVIDER_ID = 'prov-1'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Kunden-Korrekturen', is_default: false },
  { id: providerAnnotationsVariantId(PROVIDER_ID), display_name: 'Meine Anmerkungen', is_default: false },
]

beforeEach(() => {
  cleanup()
  resetMockSession()
  // The hook reads `variants` from the store for the scene's variant set.
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
})
afterEach(cleanup)

describe('VariantSwitcher', () => {
  it('shows the active variant in the Quick-Pill', () => {
    installMockSession(mockCustomerSession('cust-1'))
    render(
      <VariantSwitcher
        variants={VARIANTS}
        activeVariantId={STANDARD_VARIANTS.BASE_ROOMPLAN}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('Scan')).toBeTruthy()
  })

  it('expands a sheet listing every variant', () => {
    installMockSession(mockCustomerSession('cust-1'))
    render(
      <VariantSwitcher
        variants={VARIANTS}
        activeVariantId={STANDARD_VARIANTS.BASE_ROOMPLAN}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ebene wechseln/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Kunden-Korrekturen/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Meine Anmerkungen/ })).toBeTruthy()
  })

  it('marks the customer-corrections variant editable for a customer', () => {
    installMockSession(mockCustomerSession('cust-1'))
    render(
      <VariantSwitcher
        variants={VARIANTS}
        activeVariantId={STANDARD_VARIANTS.BASE_ROOMPLAN}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ebene wechseln/ }))
    // Customer → customer_corrections is "bearbeitbar"; base is read-only.
    expect(
      screen.getByRole('radio', { name: /Kunden-Korrekturen · bearbeitbar/ }),
    ).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Scan · nur ansehen/ })).toBeTruthy()
  })

  it('marks the OWN provider layer editable, the customer layer read-only for a provider', () => {
    installMockSession(mockOwnerSession(PROVIDER_ID))
    render(
      <VariantSwitcher
        variants={VARIANTS}
        activeVariantId={STANDARD_VARIANTS.BASE_ROOMPLAN}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ebene wechseln/ }))
    expect(
      screen.getByRole('radio', { name: /Meine Anmerkungen · bearbeitbar/ }),
    ).toBeTruthy()
    expect(
      screen.getByRole('radio', { name: /Kunden-Korrekturen · nur ansehen/ }),
    ).toBeTruthy()
  })

  it('calls onSelect with the chosen variant id and closes the sheet', () => {
    installMockSession(mockCustomerSession('cust-1'))
    const onSelect = vi.fn()
    render(
      <VariantSwitcher
        variants={VARIANTS}
        activeVariantId={STANDARD_VARIANTS.BASE_ROOMPLAN}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ebene wechseln/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Kunden-Korrekturen/ }))
    expect(onSelect).toHaveBeenCalledWith(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
