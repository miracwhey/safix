import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'

import CorrectionRejectSheet, {
  REJECT_NOTE_MIN_LENGTH,
  type CorrectionRejectSheetProps,
} from '../../../src/components/notifications/CorrectionRejectSheet'
import type { CorrectionRequest } from '../../../src/lib/corrections'

function makeCorrection(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'c-1',
    providerId: 'p-1',
    workerTeamMemberId: 'tm-1',
    workerProfileId: 'u-w-1',
    kind: 'wrong_time',
    description: 'Stunde war 14:00.',
    status: 'open',
    proposedValue: '14:30',
    createdAt: 1_746_374_400_000,
    updatedAt: 1_746_374_400_000,
    ...overrides,
  }
}

function render(props: Partial<CorrectionRejectSheetProps> = {}): string {
  const merged: CorrectionRejectSheetProps = {
    open: true,
    correction: makeCorrection(),
    workerName: 'Lisa Müller',
    note: '',
    isSubmitting: false,
    errorMessage: null,
    onNoteChange: () => {},
    onConfirm: () => {},
    onCancel: () => {},
    ...props,
  }
  return renderToString(React.createElement(CorrectionRejectSheet, merged))
}

describe('Block A3 · CorrectionRejectSheet', () => {
  it('renders nothing when open=false', () => {
    expect(render({ open: false })).toBe('')
  })

  it('renders title, hint, textarea, and submit button', () => {
    const html = render()
    expect(html).toContain('Korrektur ablehnen')
    // SSR splits sibling text+expression+text into three nodes with <!-- -->
    // separators, so check the parts independently.
    expect(html).toContain('mind.')
    expect(html).toContain(String(REJECT_NOTE_MIN_LENGTH))
    expect(html).toContain('Zeichen')
    expect(html).toContain('data-testid="correction-reject-sheet-note"')
    expect(html).toContain('Ablehnen senden')
    expect(html).toContain('Abbrechen')
  })

  /**
   * Liest das Open-Tag des Confirm-Buttons und sucht NUR nach dem
   * SSR-Attribut `disabled=""` (kein Tailwind-className-Match auf
   * `disabled:opacity-50`).
   */
  function confirmButtonHasDisabledAttr(html: string): boolean {
    const testIdIdx = html.indexOf('data-testid="correction-reject-sheet-confirm"')
    expect(testIdIdx).toBeGreaterThan(-1)
    const buttonStart = html.lastIndexOf('<button', testIdIdx)
    expect(buttonStart).toBeGreaterThan(-1)
    const buttonEnd = html.indexOf('>', testIdIdx)
    const tag = html.slice(buttonStart, buttonEnd + 1)
    // Strip className= to avoid false positives on `disabled:opacity-50`.
    const withoutClassName = tag.replace(/class="[^"]*"/g, '')
    return /\sdisabled(?:=""|=|>|\s)/.test(withoutClassName)
  }

  it('keeps the submit button disabled when note is empty', () => {
    expect(confirmButtonHasDisabledAttr(render({ note: '' }))).toBe(true)
  })

  it('keeps the submit button disabled when note is shorter than the minimum length', () => {
    expect(confirmButtonHasDisabledAttr(render({ note: 'kurz' }))).toBe(true)
  })

  it('does not disable the submit button when note is sufficient and not submitting', () => {
    expect(
      confirmButtonHasDisabledAttr(
        render({ note: 'Vorschlag passt zeitlich nicht zur Schicht.' }),
      ),
    ).toBe(false)
  })

  it('renders the error banner when errorMessage is provided', () => {
    const html = render({ errorMessage: 'Server unreachable' })
    expect(html).toContain('data-testid="correction-reject-sheet-error"')
    expect(html).toContain('Server unreachable')
  })
})
