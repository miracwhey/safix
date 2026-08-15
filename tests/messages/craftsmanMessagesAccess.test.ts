import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import BottomNav from '../../src/components/BottomNav'
import CraftsmanMessagesScreen from '../../src/screens/CraftsmanMessagesScreen'
import CraftsmanMessageThreadScreen from '../../src/screens/CraftsmanMessageThreadScreen'
import {
  InMemoryMessageRepository,
  setMessageRepository,
} from '../../src/lib/messages/repository'
import {
  InMemoryChatRepository,
  setChatRepository,
  resetChatRepository,
} from '../../src/lib/chat'

type MockSession = {
  user: { id: string } | null
  role: 'customer' | 'craftsman' | null
  craftsmanRole: 'owner' | 'worker' | null
  isOperator: boolean
  loading: boolean
  sessionValidated: boolean
  error: string | null
  errorKind: string | null
}

let session: MockSession

vi.mock('../../src/hooks/useSession', () => ({
  useSession: () => session,
}))

const craftsmanSession: MockSession = {
  user: { id: 'craftsman-1' },
  role: 'craftsman',
  craftsmanRole: 'owner',
  isOperator: false,
  loading: false,
  sessionValidated: true,
  error: null,
  errorKind: null,
}

const customerSession: MockSession = {
  user: { id: 'customer-1' },
  role: 'customer',
  craftsmanRole: null,
  isOperator: false,
  loading: false,
  sessionValidated: true,
  error: null,
  errorKind: null,
}

beforeEach(async () => {
  session = { ...craftsmanSession }
  setMessageRepository(new InMemoryMessageRepository())
  const chatRepo = new InMemoryChatRepository()
  await chatRepo.initialize()
  setChatRepository(chatRepo)
})

afterEach(() => {
  setMessageRepository(new InMemoryMessageRepository())
  resetChatRepository()
})

describe('craftsman messages access', () => {
  it('routes the messages nav item to the craftsman messages path', () => {
    session = { ...craftsmanSession }

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(BottomNav, { active: 'messages' })
      )
    )

    expect(html).toContain('href="/craftsman/messages"')
  })

  it('shows an empty state instead of redirecting when the craftsman has no threads', () => {
    session = { ...craftsmanSession }
    setMessageRepository(new InMemoryMessageRepository([], []))

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/craftsman/messages'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/craftsman/messages',
            element: React.createElement(CraftsmanMessagesScreen, null),
          })
        )
      )
    )

    expect(html).toContain('Nachrichten')
    expect(html).toMatch(/Keine (Chats gefunden|offenen Anfragen vorhanden)/)
  })

  it('opens an existing craftsman thread without bouncing to the start page', () => {
    session = { ...craftsmanSession }
    setMessageRepository(new InMemoryMessageRepository())

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/craftsman/messages/thread_1'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/craftsman/messages/:threadId',
            element: React.createElement(CraftsmanMessageThreadScreen, null),
          })
        )
      )
    )

    expect(html).toContain('Leon')
  })
})

describe('customer messages access', () => {
  it('keeps the customer messages nav path unchanged', () => {
    session = { ...customerSession }

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(BottomNav, { active: 'messages' })
      )
    )

    expect(html).toContain('href="/messages"')
  })
})
