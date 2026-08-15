/**
 * N13.OPS — operator write workflow tests.
 *
 * Mocks the supabase client surface used by the workflow:
 *   - .from('disputes').select('id, metadata').eq('id', x).maybeSingle() → { data, error }
 *   - .from('disputes').update({ metadata }).eq('id', x)                  → { error }
 *
 * Session state is installed via the project's test-only session helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelectMaybeSingle, mockUpdateEq } = vi.hoisted(() => ({
  mockSelectMaybeSingle: vi.fn(),
  mockUpdateEq: vi.fn(),
}))

let currentMetadata: unknown = null
let lastWrittenMetadata: unknown = null

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'disputes') {
        throw new Error(`unexpected table: ${table}`)
      }
      return {
        select: () => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: () => {
              mockSelectMaybeSingle(_val)
              return Promise.resolve({
                data: currentMetadata === null
                  ? null
                  : { id: _val, metadata: currentMetadata },
                error: null,
              })
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, _val: string) => {
            lastWrittenMetadata = patch.metadata
            mockUpdateEq(_val, patch)
            return Promise.resolve({ error: null })
          },
        }),
      }
    }),
  },
}))

import {
  addOperatorCommentWorkflow,
  setEvidenceCounterpartyShareWorkflow,
  OperatorWriteAuthError,
  OperatorWriteValidationError,
  OperatorWriteNotFoundError,
} from '../../src/lib/disputes/operatorWriteWorkflow'
import {
  mockCustomerSession,
  mockOwnerSession,
  installMockSession,
  resetMockSession,
} from '../helpers/mockSession'

const DISPUTE_ID = '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22'

beforeEach(() => {
  currentMetadata = {}
  lastWrittenMetadata = null
  mockSelectMaybeSingle.mockReset()
  mockUpdateEq.mockReset()
  installMockSession(mockOwnerSession('user-operator', { isOperator: true }))
})

afterEach(() => {
  resetMockSession()
  vi.clearAllMocks()
})

describe('addOperatorCommentWorkflow', () => {
  it('rejects non-operator callers (customer)', async () => {
    installMockSession(mockCustomerSession('user-customer'))
    await expect(
      addOperatorCommentWorkflow(DISPUTE_ID, 'hi'),
    ).rejects.toBeInstanceOf(OperatorWriteAuthError)
    expect(mockSelectMaybeSingle).not.toHaveBeenCalled()
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('rejects craftsman owner without operator flag', async () => {
    installMockSession(mockOwnerSession('user-owner', { isOperator: false }))
    await expect(
      addOperatorCommentWorkflow(DISPUTE_ID, 'hi'),
    ).rejects.toBeInstanceOf(OperatorWriteAuthError)
  })

  it('rejects empty body', async () => {
    await expect(
      addOperatorCommentWorkflow(DISPUTE_ID, '   '),
    ).rejects.toBeInstanceOf(OperatorWriteValidationError)
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('rejects body over the 5000 character limit', async () => {
    await expect(
      addOperatorCommentWorkflow(DISPUTE_ID, 'x'.repeat(5001)),
    ).rejects.toBeInstanceOf(OperatorWriteValidationError)
  })

  it('throws not-found when the dispute row does not exist', async () => {
    currentMetadata = null
    await expect(
      addOperatorCommentWorkflow(DISPUTE_ID, 'hi'),
    ).rejects.toBeInstanceOf(OperatorWriteNotFoundError)
  })

  it('appends a comment to an empty metadata.operator_comments array', async () => {
    currentMetadata = {}
    const { comment } = await addOperatorCommentWorkflow(DISPUTE_ID, 'Erste Stellungnahme')

    expect(comment.id).toBeDefined()
    expect(comment.body).toBe('Erste Stellungnahme')
    expect(comment.written_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const written = lastWrittenMetadata as { operator_comments: unknown[] }
    expect(Array.isArray(written.operator_comments)).toBe(true)
    expect(written.operator_comments).toHaveLength(1)
    expect(written.operator_comments[0]).toMatchObject({
      id: comment.id,
      body: 'Erste Stellungnahme',
    })
  })

  it('preserves existing metadata keys and appends to existing comments', async () => {
    currentMetadata = {
      title: 'Bad sanieren',
      sla_reminders_sent: ['h24'],
      operator_comments: [
        { id: 'cmt_old', body: 'früher', written_at: '2026-04-19T10:00:00.000Z' },
      ],
    }
    await addOperatorCommentWorkflow(DISPUTE_ID, 'Neue Notiz')

    const written = lastWrittenMetadata as Record<string, unknown>
    expect(written.title).toBe('Bad sanieren')
    expect(written.sla_reminders_sent).toEqual(['h24'])
    const comments = written.operator_comments as Array<{ id: string; body: string }>
    expect(comments).toHaveLength(2)
    expect(comments[0].id).toBe('cmt_old')
    expect(comments[1].body).toBe('Neue Notiz')
  })

  it('trims whitespace from the body', async () => {
    currentMetadata = {}
    const { comment } = await addOperatorCommentWorkflow(DISPUTE_ID, '  hello world  ')
    expect(comment.body).toBe('hello world')
  })
})

describe('setEvidenceCounterpartyShareWorkflow', () => {
  it('rejects non-operator callers', async () => {
    installMockSession(mockCustomerSession('user-customer'))
    await expect(
      setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', true),
    ).rejects.toBeInstanceOf(OperatorWriteAuthError)
  })

  it('rejects empty evidenceId', async () => {
    await expect(
      setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, '', true),
    ).rejects.toBeInstanceOf(OperatorWriteValidationError)
  })

  it('adds a new evidenceId when sharing is requested', async () => {
    currentMetadata = {}
    const result = await setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', true)
    expect(result.sharedIds).toEqual(['media-1'])
    const written = lastWrittenMetadata as { shared_evidence_ids: string[] }
    expect(written.shared_evidence_ids).toEqual(['media-1'])
  })

  it('is a no-op (no write) when re-sharing an already-shared id', async () => {
    currentMetadata = { shared_evidence_ids: ['media-1'] }
    const result = await setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', true)
    expect(result.sharedIds).toEqual(['media-1'])
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('removes an evidenceId when share=false', async () => {
    currentMetadata = { shared_evidence_ids: ['media-1', 'media-2'] }
    const result = await setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', false)
    expect(result.sharedIds).toEqual(['media-2'])
    const written = lastWrittenMetadata as { shared_evidence_ids: string[] }
    expect(written.shared_evidence_ids).toEqual(['media-2'])
  })

  it('is a no-op (no write) when revoking an id that is not currently shared', async () => {
    currentMetadata = { shared_evidence_ids: ['media-2'] }
    const result = await setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', false)
    expect(result.sharedIds).toEqual(['media-2'])
    expect(mockUpdateEq).not.toHaveBeenCalled()
  })

  it('preserves unrelated metadata keys when writing', async () => {
    currentMetadata = {
      title: 'Bad sanieren',
      operator_comments: [{ id: 'cmt_1', body: 'x', written_at: '2026-04-20T00:00:00.000Z' }],
      shared_evidence_ids: ['media-9'],
    }
    await setEvidenceCounterpartyShareWorkflow(DISPUTE_ID, 'media-1', true)
    const written = lastWrittenMetadata as Record<string, unknown>
    expect(written.title).toBe('Bad sanieren')
    expect(Array.isArray(written.operator_comments)).toBe(true)
    expect(written.shared_evidence_ids).toEqual(['media-9', 'media-1'])
  })
})
