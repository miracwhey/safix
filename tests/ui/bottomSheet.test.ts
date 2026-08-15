import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import BottomSheet from '../../src/components/ui/BottomSheet'

type SheetProps = Parameters<typeof BottomSheet>[0]

function render(
  props: Partial<SheetProps> = {},
  children: React.ReactNode = 'inner',
): string {
  return renderToString(
    React.createElement(
      BottomSheet,
      {
        open: true,
        onClose: () => {},
        ...props,
        children,
      } as SheetProps,
    ),
  )
}

describe('BottomSheet', () => {
  it('renders nothing when closed', () => {
    const html = renderToString(
      React.createElement(
        BottomSheet,
        {
          open: false,
          onClose: () => {},
          children: 'hidden-content',
        } as SheetProps,
      ),
    )
    expect(html).toBe('')
  })

  it('renders children inside dialog when open', () => {
    const html = render({}, 'visible-content')
    expect(html).toContain('visible-content')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })

  it('renders backdrop with dimming styles', () => {
    const html = render()
    expect(html).toContain('bg-black/40')
    expect(html).toContain('backdrop-blur-sm')
  })

  it('renders drag handle by default and hides it when requested', () => {
    const withHandle = render({})
    expect(withHandle).toContain('h-1 w-10 rounded-full bg-slate-200')

    const withoutHandle = render({ hideHandle: true })
    expect(withoutHandle).not.toContain('h-1 w-10 rounded-full bg-slate-200')
  })

  it('exposes title and description for screen readers when given', () => {
    const html = render({
      title: 'Angebot annehmen?',
      description: 'Beschreibungs-Text',
    })
    expect(html).toContain('Angebot annehmen?')
    expect(html).toContain('Beschreibungs-Text')
    expect(html).toContain('id="bottom-sheet-title"')
    expect(html).toContain('aria-labelledby="bottom-sheet-title"')
    expect(html).toContain('aria-describedby="bottom-sheet-description"')
  })

  it('omits aria-labelledby and aria-describedby when title/description not given', () => {
    const html = render({})
    expect(html).not.toContain('aria-labelledby')
    expect(html).not.toContain('aria-describedby')
  })

  it('respects safe-area inset on bottom padding for iOS notch', () => {
    const html = render()
    expect(html).toContain('env(safe-area-inset-bottom)')
  })

  it('honours custom maxWidth', () => {
    const html = render({ maxWidth: 560 })
    expect(html).toContain('max-width:560px')
  })
})
