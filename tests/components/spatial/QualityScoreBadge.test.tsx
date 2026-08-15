// @vitest-environment jsdom
/**
 * Render tests for the Block-3.2 `QualityScoreBadge` (VF-1 simplified score).
 *
 * Covers: the simplified one-number display, the bucket label, and the
 * tap-to-detail affordance (interactive only when `onOpenDetail` is given).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { QualityScoreBadge } from '../../../src/components/spatial/verify/QualityScoreBadge'
import type { QualityResult } from '../../../src/lib/spatial/quality/qualityEngine'

const GOOD: QualityResult = {
  score: 87,
  bucket: 'good',
  warnings: [],
  engineVersion: 'v1.0.0',
}

afterEach(cleanup)

describe('QualityScoreBadge', () => {
  it('shows the simplified score + label (VF-1 — one number, no rule list)', () => {
    render(<QualityScoreBadge quality={GOOD} label="Gut" />)
    const badge = screen.getByTestId('quality-score-badge')
    expect(badge.textContent).toContain('87')
    expect(badge.textContent).toContain('Gut')
  })

  it('is interactive (a button) when onOpenDetail is provided', () => {
    const onOpenDetail = vi.fn()
    render(<QualityScoreBadge quality={GOOD} label="Gut" onOpenDetail={onOpenDetail} />)
    const badge = screen.getByTestId('quality-score-badge')
    expect(badge.tagName).toBe('BUTTON')
    fireEvent.click(badge)
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('is non-interactive (a div) when onOpenDetail is omitted', () => {
    render(<QualityScoreBadge quality={GOOD} label="Gut" />)
    expect(screen.getByTestId('quality-score-badge').tagName).toBe('DIV')
  })

  it('carries an accessible label naming the score', () => {
    render(<QualityScoreBadge quality={GOOD} label="Gut" />)
    expect(
      screen.getByLabelText(/Aufmaß-Qualität 87 von 100/),
    ).toBeTruthy()
  })
})
