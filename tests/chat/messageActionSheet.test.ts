// @vitest-environment jsdom
/**
 * MessageActionSheet + MessageTombstone render tests (Block 3).
 * .test.ts + createElement (the .test.tsx glob is scoped to the spatial tree).
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import {
  MessageActionSheet,
  MessageTombstone,
} from '../../src/components/chat/MessageActionSheet'

afterEach(cleanup)

describe('MessageActionSheet', () => {
  it('offers "Für alle" + "Für mich" when canDeleteForAll', () => {
    render(
      createElement(MessageActionSheet, {
        canDeleteForAll: true,
        busy: false,
        error: null,
        onPick: vi.fn(),
        onDismiss: vi.fn(),
      }),
    )
    expect(screen.queryByText('Für alle löschen')).toBeTruthy()
    expect(screen.queryByText('Für mich löschen')).toBeTruthy()
  })

  it('hides "Für alle" when the window has passed / not own', () => {
    render(
      createElement(MessageActionSheet, {
        canDeleteForAll: false,
        busy: false,
        error: null,
        onPick: vi.fn(),
        onDismiss: vi.fn(),
      }),
    )
    expect(screen.queryByText('Für alle löschen')).toBeNull()
    expect(screen.queryByText('Für mich löschen')).toBeTruthy()
  })

  it('surfaces an error message', () => {
    render(
      createElement(MessageActionSheet, {
        canDeleteForAll: true,
        busy: false,
        error: 'Das 15-Minuten-Fenster zum Löschen für alle ist abgelaufen.',
        onPick: vi.fn(),
        onDismiss: vi.fn(),
      }),
    )
    expect(
      screen.queryByText('Das 15-Minuten-Fenster zum Löschen für alle ist abgelaufen.'),
    ).toBeTruthy()
  })
})

describe('MessageTombstone', () => {
  it('renders the deleted placeholder', () => {
    render(createElement(MessageTombstone, { createdAt: Date.now(), isOwnBubble: true }))
    expect(screen.queryByText('Diese Nachricht wurde gelöscht')).toBeTruthy()
  })
})
