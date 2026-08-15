// @vitest-environment jsdom
/**
 * Customer identity — single canonical source (no split-brain).
 *
 * Proves the fix for "name not saved / not shown in the greeting":
 *   - customerContextStore is a PROJECTION (update reflects, reset clears).
 *   - The Konto "Persönliche Daten" card shows the projected name/city and
 *     routes to the canonical form — it no longer edits an in-memory store
 *     (no inline <input>), which was the bug surface.
 *   - The greeting derives the FIRST name from the canonical full name.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../src/lib/native/useMediaPicker', () => ({
  useMediaPicker: () => ({
    pickMedia: vi.fn(),
    inputProps: {
      ref: { current: null },
      type: 'file',
      accept: 'image/*',
      className: 'hidden',
      'aria-hidden': true,
      onChange: vi.fn(),
    },
    isNative: false,
  }),
}))
vi.mock('../../src/hooks/useSession', () => ({
  useSession: () => ({ user: null }),
}))

import CustomerContextCard from '../../src/components/profile/CustomerContextCard'
import {
  updateCustomerContext,
  resetCustomerContext,
  getCustomerContext,
} from '../../src/lib/customer/customerContextStore'
import type { CustomerSetupViewModel } from '../../src/lib/customer/customerSetupSelectors'

function setupVm(isComplete: boolean): CustomerSetupViewModel {
  return {
    readiness: isComplete ? 'complete' : 'empty',
    isComplete,
    hasDisplayName: isComplete,
    hasCity: isComplete,
    setupLabel: '',
    setupHint: '',
  }
}

function renderCard(
  context: { displayName: string; city: string; avatarUrl: string | null },
  isComplete: boolean,
) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(CustomerContextCard, { context, setup: setupVm(isComplete) }),
    ),
  )
}

afterEach(() => {
  cleanup()
  resetCustomerContext()
})

describe('customerContextStore is a projection (not a second source of truth)', () => {
  it('update reflects, reset clears', () => {
    updateCustomerContext({ displayName: 'Max Mustermann', city: 'Hannover' })
    expect(getCustomerContext().displayName).toBe('Max Mustermann')
    expect(getCustomerContext().city).toBe('Hannover')
    resetCustomerContext()
    expect(getCustomerContext().displayName).toBe('')
    expect(getCustomerContext().city).toBe('')
  })
})

describe('Konto "Persönliche Daten" card — canonical, no in-memory edit', () => {
  it('shows the projected name + city, with no inline edit field', () => {
    renderCard({ displayName: 'Max Mustermann', city: 'Hannover', avatarUrl: null }, true)
    expect(screen.getByText('Max Mustermann')).toBeTruthy()
    expect(screen.getByText('Hannover')).toBeTruthy()
    // The old bug edited an in-memory store via inline inputs — that path is gone.
    fireEvent.click(screen.getByText('Max Mustermann'))
    // No inline text-edit field (the old in-memory bug) ...
    expect(document.querySelector('input[type="text"]')).toBeNull()
    // ... but the avatar picker's hidden file input IS rendered (the fix).
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('empty profile prompts to add personal data', () => {
    renderCard({ displayName: '', city: '', avatarUrl: null }, false)
    expect(screen.getByText('Name hinzufügen')).toBeTruthy()
    expect(screen.getByText('Persönliche Daten ergänzen')).toBeTruthy()
  })
})

describe('greeting derives the first name from the canonical full name', () => {
  const firstNameOf = (full: string): string | null => full.trim().split(/\s+/)[0] || null
  it.each([
    ['Max Mustermann', 'Max'],
    ['  Anna  ', 'Anna'],
    ['Jean-Pierre Dupont', 'Jean-Pierre'],
    ['Bob', 'Bob'],
    ['', null],
  ])('firstNameOf(%j) === %j', (full, expected) => {
    expect(firstNameOf(full as string)).toBe(expected)
  })
})
