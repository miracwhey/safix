import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import type { Conversation } from '../../src/lib/messages'
import type { Project } from '../../src/lib/projects'
import { setupCleanRepositories } from '../helpers/setupRepositories'

function renderThread(threadId: string) {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/messages/${threadId}`] },
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
}

describe('Message thread handoff persistence', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('hides attach UI and shows project context when the thread is already linked', () => {
    const project: Project = {
      id: 'proj-linked',
      sourceJobId: 'job-1',
      title: 'Linked Project',
      customer: 'Kunde',
      craftsman: 'Handwerker',
      location: 'Berlin',
      dateLabel: 'Offen',
      price: '500 €',
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const conversation: Conversation = {
      id: 'thread-linked',
      projectId: 'proj-linked',
      sourceProjectId: 'proj-linked',
      customerName: 'Max Mustermann',
      customerAvatarUrl: '',
      customerUserId: 'cust-1',
      craftsmanName: 'Handwerker',
      craftsmanHandle: '@handwerker',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-1',
      projectTitle: 'Linked Project',
      projectSubtitle: 'Übergeben',
      projectLocation: 'Berlin',
      timeLabel: 'Jetzt',
      createdAt: Date.now(),
    }

    setProjectRepository(new InMemoryProjectRepository([project]))
    setMessageRepository(new InMemoryMessageRepository([conversation], []))

    const html = renderThread(conversation.id)

    expect(html).toContain('Öffnen →')
    expect(html).not.toContain('Projekt anhängen')
  })

  it('keeps the linked state after a reload (repository rehydration)', () => {
    const project: Project = {
      id: 'proj-reload',
      sourceJobId: 'job-2',
      title: 'Reloaded Project',
      customer: 'Kunde',
      craftsman: 'Handwerker',
      location: 'Hamburg',
      dateLabel: 'Offen',
      price: '900 €',
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const conversation: Conversation = {
      id: 'thread-reload',
      projectId: 'proj-reload',
      sourceProjectId: 'proj-reload',
      customerName: 'Erika',
      customerAvatarUrl: '',
      customerUserId: 'cust-2',
      craftsmanName: 'Handwerker',
      craftsmanHandle: '@handwerker',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-2',
      projectTitle: 'Reloaded Project',
      projectSubtitle: 'Übergeben',
      projectLocation: 'Hamburg',
      timeLabel: 'Heute',
      createdAt: Date.now(),
    }

    setProjectRepository(new InMemoryProjectRepository([project]))
    setMessageRepository(new InMemoryMessageRepository([conversation], []))
    const firstRender = renderThread(conversation.id)
    expect(firstRender).toContain('Öffnen →')
    expect(firstRender).not.toContain('Projekt anhängen')

    // Simulate reload by rehydrating repositories with the same canonical data
    setProjectRepository(new InMemoryProjectRepository([project]))
    setMessageRepository(new InMemoryMessageRepository([conversation], []))
    const secondRender = renderThread(conversation.id)
    expect(secondRender).toContain('Öffnen →')
    expect(secondRender).not.toContain('Projekt anhängen')
  })

  it('keeps the attach affordance when no project/job linkage exists', () => {
    const conversation: Conversation = {
      id: 'thread-unlinked',
      projectId: 'proj-unlinked',
      customerName: 'Anna',
      customerAvatarUrl: '',
      customerUserId: 'cust-3',
      craftsmanName: 'Handwerker',
      craftsmanHandle: '@handwerker',
      craftsmanAvatarUrl: '',
      craftsmanUserId: 'craft-3',
      projectTitle: 'Locker',
      projectSubtitle: 'Anfrage',
      projectLocation: 'Köln',
      timeLabel: 'Vorhin',
      createdAt: Date.now(),
    }

    setMessageRepository(new InMemoryMessageRepository([conversation], []))

    const html = renderThread(conversation.id)
    expect(html).toContain('Projekt anhängen')
  })
})
