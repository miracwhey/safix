import { describe, expect, it } from 'vitest'

import type { InternalMessage } from '../../src/lib/internalMessages/types'

/**
 * Lightweight type-shape tests for the sender_kind extension. The real
 * render behaviour is exercised in the e2e/manual smoke (Block 3 §4.12 #11)
 * — vitest doesn't run JSX. These tests confirm the type contract holds:
 *   - 'user' messages have senderTeamMemberId set;
 *   - 'system' messages have senderTeamMemberId null;
 *   - the discriminator unions cleanly so consumers can branch on senderKind.
 */
describe('InternalMessage sender_kind type contract', () => {
  it('user message has a string senderTeamMemberId', () => {
    const msg: InternalMessage = {
      id: 'msg-1',
      threadId: 'thr-1',
      senderTeamMemberId: 'tm-1',
      senderKind: 'user',
      body: 'Hallo',
      messageKind: 'text',
      createdAt: 1000,
    }
    expect(msg.senderTeamMemberId).toBe('tm-1')
    expect(msg.senderKind).toBe('user')
  })

  it('system message has senderTeamMemberId null', () => {
    const msg: InternalMessage = {
      id: 'msg-2',
      threadId: 'thr-1',
      senderTeamMemberId: null,
      senderKind: 'system',
      body: 'Anna hat sich krankgemeldet.',
      messageKind: 'text',
      createdAt: 2000,
    }
    expect(msg.senderTeamMemberId).toBeNull()
    expect(msg.senderKind).toBe('system')
  })

  it('discriminator allows the consumer to branch on senderKind', () => {
    const messages: InternalMessage[] = [
      {
        id: '1',
        threadId: 't',
        senderTeamMemberId: 'tm-1',
        senderKind: 'user',
        body: 'Hi',
        messageKind: 'text',
        createdAt: 1,
      },
      {
        id: '2',
        threadId: 't',
        senderTeamMemberId: null,
        senderKind: 'system',
        body: 'Bert ist krank.',
        messageKind: 'text',
        createdAt: 2,
      },
    ]
    const systemBodies = messages
      .filter((m) => m.senderKind === 'system')
      .map((m) => m.body)
    expect(systemBodies).toEqual(['Bert ist krank.'])
  })
})
