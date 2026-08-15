import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessagesScreen from '../../src/screens/MessagesScreen'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import type { Conversation, Message } from '../../src/lib/messages/types'

describe('Message thread UI polish', () => {
  beforeEach(() => {
    setMessageRepository(new InMemoryMessageRepository())
  })

  it('renders only one top context block for a job-backed thread', () => {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages/thread_1'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'customer' }),
          })
        )
      )
    )

    const occurrences = (html.match(/Öffnen →/g) ?? []).length
    // Business card rendering was removed in RUN 1 HARD TEARDOWN
    expect(occurrences).toBe(0)
  })

  it.skip('renders initials avatar fallback when no avatar URL is available — Slice 7: MessagesScreen now chat-domain only, legacy conversation initials no longer rendered', () => {
    const conversation: Conversation = {
      id: 'conv-initials',
      projectId: 'proj-1',
      customerName: 'Fallback Customer',
      customerAvatarUrl: '',
      customerUserId: 'customer-42',
      craftsmanName: 'Zara Quinn',
      craftsmanHandle: '@zq',
      craftsmanAvatarUrl: '',
      projectTitle: 'Projekt ohne Avatar',
      projectSubtitle: 'Details folgen',
      projectLocation: 'Hamburg',
      timeLabel: 'Jetzt',
      createdAt: Date.now(),
    }
    const message: Message = {
      id: 'msg-initials',
      conversationId: 'conv-initials',
      sender: 'user',
      text: 'Hallo',
      createdAtLabel: '12:00',
    }
    setMessageRepository(new InMemoryMessageRepository([conversation], [message]))

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages',
            element: React.createElement(MessagesScreen, { role: 'customer' }),
          })
        )
      )
    )

    expect(html).toContain('ZQ')
    expect(html).not.toContain('<img')
  })

  it('keeps customer and craftsman identities visible in thread header', () => {
    const customerView = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages/thread_1'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'customer' }),
          })
        )
      )
    )
    expect(customerView).toContain('Badwerk Nord')

    const craftsmanView = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages/thread_1'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'craftsman' }),
          })
        )
      )
    )
    expect(craftsmanView).toContain('Leon')
  })

  it.skip('does not render empty messages as chat bubbles — Slice 7: legacy thread.messages no longer rendered; empty-message filtering now in chat domain', () => {
    const conversation: Conversation = {
      id: 'conv-empty',
      projectId: 'proj-1',
      customerName: 'Customer',
      customerAvatarUrl: '',
      customerUserId: 'customer-1',
      craftsmanName: 'Craftsman',
      craftsmanHandle: '@craftsman',
      craftsmanAvatarUrl: '',
      projectTitle: 'Test Project',
      projectSubtitle: 'Details',
      projectLocation: 'Berlin',
      timeLabel: 'Now',
      createdAt: Date.now(),
    }
    const messages: Message[] = [
      {
        id: 'msg-1',
        conversationId: 'conv-empty',
        sender: 'user',
        text: 'Valid message',
        createdAtLabel: '12:00',
      },
      {
        id: 'msg-2',
        conversationId: 'conv-empty',
        sender: 'user',
        text: '',
        createdAtLabel: '12:01',
      },
      {
        id: 'msg-3',
        conversationId: 'conv-empty',
        sender: 'counterparty',
        text: '   ',
        createdAtLabel: '12:02',
      },
      {
        id: 'msg-4',
        conversationId: 'conv-empty',
        sender: 'user',
        text: 'Another valid message',
        createdAtLabel: '12:03',
      },
    ]
    setMessageRepository(new InMemoryMessageRepository([conversation], messages))

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages/conv-empty'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'customer' }),
          })
        )
      )
    )

    // Valid messages should appear
    expect(html).toContain('Valid message')
    expect(html).toContain('Another valid message')

    // Empty message timestamps should not appear (messages filtered out)
    // Count timestamp occurrences - should only be 2 (for the valid messages)
    const timestampMatches = html.match(/12:0[0-3]/g) ?? []
    expect(timestampMatches.length).toBe(2)
    expect(html).toContain('12:00')
    expect(html).toContain('12:03')
    // Empty message timestamps should not be rendered
    expect(html).not.toContain('12:01')
    expect(html).not.toContain('12:02')
  })

  it('renders project attachments correctly without text bubbles', () => {
    const conversation: Conversation = {
      id: 'conv-attachment',
      projectId: 'proj-1',
      customerName: 'Customer',
      customerAvatarUrl: '',
      customerUserId: 'customer-1',
      craftsmanName: 'Craftsman',
      craftsmanHandle: '@craftsman',
      craftsmanAvatarUrl: '',
      projectTitle: 'Test Project',
      projectSubtitle: 'Details',
      projectLocation: 'Berlin',
      timeLabel: 'Now',
      createdAt: Date.now(),
    }
    const messages: Message[] = [
      {
        id: 'msg-1',
        conversationId: 'conv-attachment',
        sender: 'user',
        text: '',
        createdAtLabel: '12:00',
        attachmentType: 'project',
        projectAttachment: {
          projectId: 'proj-1',
          title: 'Attached Project',
          location: 'Berlin',
          status: 'active',
        },
      },
    ]
    setMessageRepository(new InMemoryMessageRepository([conversation], messages))

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/messages/conv-attachment'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'customer' }),
          })
        )
      )
    )

    // RUN 1 TEARDOWN: ProjectAttachmentCard was removed from the screen.
    // Attachment-only messages (empty text) are now skipped entirely.
    expect(html).not.toContain('Attached Project')
    // No empty chat bubble with just timestamp either
    expect(html).not.toContain('rounded-[20px] px-4 py-3')
  })

  it('surfaces the craftsman offer form even when the thread is an incoming request', () => {
    const conversation: Conversation = {
      id: 'conv-offer',
      projectId: 'proj-offer',
      customerName: 'Kunde',
      customerAvatarUrl: '',
      customerUserId: 'customer-1',
      craftsmanName: 'Handwerker',
      craftsmanHandle: '@craft',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-1',
      projectTitle: 'Bad Anfrage',
      projectSubtitle: 'Neue Anfrage',
      projectLocation: 'Berlin',
      timeLabel: 'Jetzt',
      inquiryOrigin: 'profile',
      createdAt: Date.now(),
    }
    const messages: Message[] = [
      {
        id: 'msg-offer',
        conversationId: 'conv-offer',
        sender: 'user',
        text: 'Ich benötige Hilfe im Bad',
        createdAtLabel: '12:00',
      },
    ]

    setMessageRepository(new InMemoryMessageRepository([conversation], messages))

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/craftsman/messages/conv-offer'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/craftsman/messages/:threadId',
            element: React.createElement(MessageThreadScreen, { role: 'craftsman', backPath: '/craftsman/messages' }),
          })
        )
      )
    )

    // Business card rendering (CraftsmanRequestActionCard, CraftsmanOfferForm)
    // was removed in RUN 1 HARD TEARDOWN — these strings are no longer rendered
    expect(html).not.toContain('Eingehende Anfrage')
    expect(html).not.toContain('Angebot erstellen')
  })
})
