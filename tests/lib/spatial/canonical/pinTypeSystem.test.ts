/**
 * pinTypeSystem · domain-layer Customer pin-type contract.
 *
 * Keeps colour, label, and default-dim values locked so a downstream
 * refactor doesn't silently drift away from Master-Plan B.2-D3 (Mockup 02
 * v9 colour palette) or DIN-standard default dimensions.
 */

import { describe, it, expect } from 'vitest'

import {
  CUSTOMER_PIN_TYPES,
  getCustomerPinTypeColor,
  getCustomerPinTypeLabel,
  getCustomerPinTypeSpec,
  isCustomerPinType,
} from '../../../../src/lib/spatial/canonical/pins/pinTypeSystem'

describe('pinTypeSystem', () => {
  it('exposes all four pin types in stable order', () => {
    expect(CUSTOMER_PIN_TYPES).toEqual([
      'door',
      'window',
      'heating',
      'electrical',
    ])
  })

  it('locks the Master-Plan B.2-D3 colour palette', () => {
    expect(getCustomerPinTypeColor('door')).toBe('#7c3aed')
    expect(getCustomerPinTypeColor('window')).toBe('#0891b2')
    expect(getCustomerPinTypeColor('heating')).toBe('#dc2626')
    expect(getCustomerPinTypeColor('electrical')).toBe('#f59e0b')
  })

  it('uses German labels (no English fallbacks)', () => {
    expect(getCustomerPinTypeLabel('door')).toBe('Tür')
    expect(getCustomerPinTypeLabel('window')).toBe('Fenster')
    expect(getCustomerPinTypeLabel('heating')).toBe('Heizung')
    expect(getCustomerPinTypeLabel('electrical')).toBe('Elektro')
  })

  it('sets DIN-standard default dimensions per type', () => {
    expect(getCustomerPinTypeSpec('door').defaultDims).toEqual({
      widthM: 0.8,
      heightM: 2.1,
    })
    expect(getCustomerPinTypeSpec('window').defaultDims).toEqual({
      widthM: 1.2,
      heightM: 1.4,
    })
    const heating = getCustomerPinTypeSpec('heating').defaultDims
    expect(heating.widthM).toBe(0.6)
    expect(heating.heightM).toBe(0.6)
    expect(heating.depthM).toBe(0.12)
    expect(getCustomerPinTypeSpec('electrical').defaultDims).toEqual({
      widthM: 0.08,
      heightM: 0.08,
    })
  })

  describe('isCustomerPinType (type guard)', () => {
    it('accepts the four valid keys', () => {
      expect(isCustomerPinType('door')).toBe(true)
      expect(isCustomerPinType('window')).toBe(true)
      expect(isCustomerPinType('heating')).toBe(true)
      expect(isCustomerPinType('electrical')).toBe(true)
    })

    it('rejects unrelated strings + non-strings', () => {
      expect(isCustomerPinType('plumbing')).toBe(false)
      expect(isCustomerPinType('wall')).toBe(false)
      expect(isCustomerPinType('')).toBe(false)
      expect(isCustomerPinType(null)).toBe(false)
      expect(isCustomerPinType(undefined)).toBe(false)
      expect(isCustomerPinType(42)).toBe(false)
    })
  })
})
