// @vitest-environment jsdom
/**
 * Tests for {@link HubFilterSheet} — dirty-only apply, reset, draft scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { HubFilterSheet } from '../../../../src/components/spatial/hub/HubFilterSheet'
import {
  DEFAULT_HUB_FILTER,
  isHubFilterActive,
  type HubFilterValue,
} from '../../../../src/components/spatial/hub/hubFilterModel'

afterEach(cleanup)

describe('hubFilterModel', () => {
  it('default is inactive', () => {
    expect(isHubFilterActive(DEFAULT_HUB_FILTER)).toBe(false)
  })

  it('any non-default axis flips active', () => {
    expect(isHubFilterActive({ ...DEFAULT_HUB_FILTER, status: 'presales' })).toBe(true)
    expect(isHubFilterActive({ ...DEFAULT_HUB_FILTER, date: 'today' })).toBe(true)
    expect(isHubFilterActive({ ...DEFAULT_HUB_FILTER, source: 'job' })).toBe(true)
  })
})

describe('HubFilterSheet', () => {
  it('Anwenden is disabled while draft equals value', () => {
    render(
      <HubFilterSheet value={DEFAULT_HUB_FILTER} onApply={() => {}} onClose={() => {}} />,
    )
    const apply = screen.getByRole('button', { name: /Anwenden/ }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('selecting a chip enables Anwenden + commits draft to onApply', () => {
    const onApply = vi.fn<(next: HubFilterValue) => void>()
    render(<HubFilterSheet value={DEFAULT_HUB_FILTER} onApply={onApply} onClose={() => {}} />)
    // 2x "Aufmaß" chips (Status group + Source group, post-L2-B Wording-Lock D-5)
    // — pick the first (Status).
    const presalesChips = screen.getAllByRole('tab', { name: 'Aufmaß' })
    fireEvent.click(presalesChips[0])
    const apply = screen.getByRole('button', { name: /Anwenden/ }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    expect(onApply).toHaveBeenCalledTimes(1)
    const arg = onApply.mock.calls[0][0]
    expect(arg.status).toBe('presales')
  })

  it('Zurücksetzen reverts draft to DEFAULT', () => {
    render(
      <HubFilterSheet
        value={{ status: 'aktiv', date: 'week', source: 'job' }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Zurücksetzen/ }))
    // After reset the chip "Alle" should be selected in each group.
    const allSelected = screen.getAllByRole('tab', { name: 'Alle', selected: true })
    expect(allSelected.length).toBeGreaterThanOrEqual(2)
  })
})
