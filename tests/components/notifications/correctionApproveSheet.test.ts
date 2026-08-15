import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'

import CorrectionApproveSheet, {
  type CorrectionApproveSheetProps,
} from '../../../src/components/notifications/CorrectionApproveSheet'
import type { CorrectionRequest } from '../../../src/lib/corrections'

function makeCorrection(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'c-1',
    providerId: 'p-1',
    workerTeamMemberId: 'tm-1',
    workerProfileId: 'u-w-1',
    kind: 'wrong_time',
    description: 'Stunde war 14:00, korrekt wäre 14:30.',
    status: 'open',
    field: 'Startzeit',
    currentValue: '14:00',
    proposedValue: '14:30',
    createdAt: 1_746_374_400_000,
    updatedAt: 1_746_374_400_000,
    ...overrides,
  }
}

function render(props: Partial<CorrectionApproveSheetProps> = {}): string {
  const merged: CorrectionApproveSheetProps = {
    open: true,
    correction: makeCorrection(),
    workerName: 'Lisa Müller',
    isSubmitting: false,
    errorMessage: null,
    onConfirm: () => {},
    onCancel: () => {},
    ...props,
  }
  return renderToString(React.createElement(CorrectionApproveSheet, merged))
}

describe('Block A3 · CorrectionApproveSheet', () => {
  it('renders nothing when open=false', () => {
    expect(render({ open: false })).toBe('')
  })

  it('renders the German title and confirm button label by default', () => {
    const html = render()
    expect(html).toContain('Korrektur annehmen?')
    expect(html).toContain('Annehmen')
    expect(html).toContain('Abbrechen')
    expect(html).toContain('Lisa Müller')
  })

  it('shows the structured currentValue/proposedValue diff', () => {
    const html = render()
    expect(html).toContain('14:00')
    expect(html).toContain('14:30')
  })

  it('switches the confirm button label to "Wird übernommen…" while submitting', () => {
    const html = render({ isSubmitting: true })
    expect(html).toContain('Wird übernommen…')
    // Both buttons must be disabled while submitting
    expect(html).toContain('disabled')
  })

  it('renders an error banner with data-testid when errorMessage is provided', () => {
    const html = render({ errorMessage: 'Korrektur ist bereits abgeschlossen.' })
    expect(html).toContain('data-testid="correction-approve-sheet-error"')
    expect(html).toContain('Korrektur ist bereits abgeschlossen.')
  })
})
