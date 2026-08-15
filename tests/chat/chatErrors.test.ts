import { describe, it, expect } from 'vitest'
import {
  ChatRBACError,
  ChatMigrationPendingError,
  ChatStorageUploadError,
  classifyChatSendError,
} from '../../src/lib/chat/errors'
import { OfflineError } from '../../src/lib/chat/uploadWithRetry'
import {
  ChatRBACError as ChatRBACErrorReexport,
  ChatMigrationPendingError as ChatMigrationPendingErrorReexport,
} from '../../src/lib/workflow/chatWorkflow'

describe('ChatRBACError', () => {
  it('exposes typed code', () => {
    const e = new ChatRBACError('worker_in_customer_channel', 'msg')
    expect(e.code).toBe('worker_in_customer_channel')
    expect(e.name).toBe('ChatRBACError')
    expect(e instanceof Error).toBe(true)
  })

  it('is re-exported from workflow with same identity', () => {
    expect(ChatRBACErrorReexport).toBe(ChatRBACError)
  })

  it('survives instanceof across catch boundary', () => {
    try {
      throw new ChatRBACError('thread_not_found', 'gone')
    } catch (err) {
      expect(err instanceof ChatRBACError).toBe(true)
      expect((err as ChatRBACError).code).toBe('thread_not_found')
    }
  })
})

describe('ChatMigrationPendingError', () => {
  it('always has code = migration_pending', () => {
    const e = new ChatMigrationPendingError('t1', 'not_migrated')
    expect(e.code).toBe('migration_pending')
    expect(e.name).toBe('ChatMigrationPendingError')
    expect(e.threadId).toBe('t1')
    expect(e.migrationStatus).toBe('not_migrated')
  })

  it('is distinct from ChatRBACError', () => {
    const e = new ChatMigrationPendingError('t1', 'migrating')
    expect(e instanceof ChatRBACError).toBe(false)
    expect(e instanceof ChatMigrationPendingError).toBe(true)
  })

  it('is re-exported from workflow with same identity', () => {
    expect(ChatMigrationPendingErrorReexport).toBe(ChatMigrationPendingError)
  })

  it('captures the migration status for UI surface', () => {
    const e = new ChatMigrationPendingError('legacy:conversations:abc', 'migration_failed')
    expect(e.message).toContain('legacy:conversations:abc')
    expect(e.message).toContain('migration_failed')
  })
})

describe('ChatStorageUploadError', () => {
  it('carries HTTP status + raw storage reason for classification + diagnostics', () => {
    const e = new ChatStorageUploadError('User-facing message', {
      status: 400,
      storageReason: 'mime type audio/webm is not supported',
    })
    expect(e.status).toBe(400)
    expect(e.storageReason).toBe('mime type audio/webm is not supported')
    expect(e.name).toBe('ChatStorageUploadError')
    expect(e.message).toBe('User-facing message')
    expect(e instanceof Error).toBe(true)
  })

  it('defaults status to null and storageReason to the message', () => {
    const e = new ChatStorageUploadError('msg')
    expect(e.status).toBeNull()
    expect(e.storageReason).toBe('msg')
  })
})

describe('classifyChatSendError', () => {
  // Producer-shape regression (Verify-P0): the uploader wraps EVERY storage
  // failure in ChatStorageUploadError with a German user message — the
  // English-pattern transient regex can never match it, so classification
  // must key on `.status` (mirror of uploadWithRetry.isRetryable).
  it('ChatStorageUploadError status 0 (network) → transient, retryable', () => {
    const c = classifyChatSendError(
      new ChatStorageUploadError('Datei konnte nicht hochgeladen werden. Bitte erneut versuchen.', {
        status: 0,
        storageReason: 'Upload Netzwerkfehler',
      }),
    )
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it('ChatStorageUploadError status null (timeout/stall abort) → transient, retryable', () => {
    const c = classifyChatSendError(
      new ChatStorageUploadError('Sprachnachricht konnte nicht hochgeladen werden.', {
        status: null,
        storageReason: 'Zeitüberschreitung',
      }),
    )
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it.each([408, 429, 500, 503])(
    'ChatStorageUploadError status %i → transient, retryable',
    (status) => {
      const c = classifyChatSendError(new ChatStorageUploadError('msg', { status }))
      expect(c.klass).toBe('transient')
      expect(c.retryable).toBe(true)
    },
  )

  it('ChatStorageUploadError 400 (mime/RLS reject) → permanent, keeps user message', () => {
    const c = classifyChatSendError(
      new ChatStorageUploadError('Dateityp wird nicht unterstützt.', {
        status: 400,
        storageReason: 'mime type not supported',
      }),
    )
    expect(c.klass).toBe('unknown')
    expect(c.retryable).toBe(false)
    expect(c.userMessage).toBe('Dateityp wird nicht unterstützt.')
  })

  it('RLS 42501 → authz, non-retryable, German message', () => {
    const c = classifyChatSendError({
      code: '42501',
      message: 'new row violates row-level security policy for table "chat_messages"',
    })
    expect(c.klass).toBe('authz')
    expect(c.retryable).toBe(false)
    expect(c.userMessage).toBe('Du kannst in dieser Unterhaltung gerade nicht senden.')
    expect(c.userMessage).not.toContain('row-level security')
  })

  it('RPC guard P0001 → authz, non-retryable', () => {
    const c = classifyChatSendError({ code: 'P0001', message: 'access_denied: caller is not a participant' })
    expect(c.klass).toBe('authz')
    expect(c.retryable).toBe(false)
  })

  it('PostgREST 403 status → authz, non-retryable', () => {
    const c = classifyChatSendError({ status: 403, message: 'Forbidden' })
    expect(c.klass).toBe('authz')
    expect(c.retryable).toBe(false)
  })

  it('ChatRBACError (thread_not_found) → authz, non-retryable', () => {
    const c = classifyChatSendError(new ChatRBACError('thread_not_found', 'gone'))
    expect(c.klass).toBe('authz')
    expect(c.retryable).toBe(false)
    expect(c.code).toBe('thread_not_found')
  })

  it('ChatMigrationPendingError → transient, retryable', () => {
    const c = classifyChatSendError(new ChatMigrationPendingError('t1', 'migrating'))
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it('AbortSignal.timeout DOMException (name=TimeoutError) → transient, retryable', () => {
    const c = classifyChatSendError({ name: 'TimeoutError', message: 'signal timed out' })
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  // postgrest-js v2.98 maps an aborted fetch to { code: '' (empty string),
  // message: 'TimeoutError: …' } with NO top-level `name` — the shape the repo
  // actually throws. This MUST classify transient (regression guard for the
  // misclassification that defeated the whole retryable-transient intent).
  it('REAL postgrest abort shape { code: "", message: "TimeoutError: …" } → transient, retryable', () => {
    const c = classifyChatSendError({ code: '', message: 'TimeoutError: signal timed out', details: '', hint: '' })
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it('REAL postgrest abort shape { code: "", message: "AbortError: …" } → transient, retryable', () => {
    const c = classifyChatSendError({ code: '', message: 'AbortError: The user aborted a request.' })
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it('PG connection-class code (08006) → transient, retryable', () => {
    const c = classifyChatSendError({ code: '08006', message: 'connection failure' })
    expect(c.retryable).toBe(true)
  })

  it('Failed to fetch (network) → transient, retryable', () => {
    const c = classifyChatSendError(new TypeError('Failed to fetch'))
    expect(c.retryable).toBe(true)
  })

  it('repo "no authenticated session" (English, code-less) → transient, German message', () => {
    const c = classifyChatSendError(new Error('chat.sendMessage: no authenticated session'))
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
    expect(c.userMessage).toContain('Sitzung wird verbunden')
  })

  it('OfflineError → transient, retryable', () => {
    const c = classifyChatSendError(new OfflineError())
    expect(c.klass).toBe('transient')
    expect(c.retryable).toBe(true)
  })

  it('cold-start session throw → transient, retryable, keeps German message', () => {
    const c = classifyChatSendError(new Error('Sitzung wird verbunden. Bitte einen Moment warten und erneut versuchen.'))
    expect(c.retryable).toBe(true)
    expect(c.userMessage).toContain('Sitzung wird verbunden')
  })

  it('moderation plain Error (German, code-less) → kept message, non-retryable', () => {
    const c = classifyChatSendError(new Error('Nachricht kann nicht gesendet werden — Nutzer ist blockiert.'))
    expect(c.klass).toBe('moderation')
    expect(c.retryable).toBe(false)
    expect(c.userMessage).toBe('Nachricht kann nicht gesendet werden — Nutzer ist blockiert.')
  })

  it('unmapped code-carrying server reject → non-retryable, generic German', () => {
    const c = classifyChatSendError({ code: '23502', message: 'null value in column violates not-null' })
    expect(c.klass).toBe('unknown')
    expect(c.retryable).toBe(false)
    expect(c.userMessage).toBe('Nachricht konnte nicht gesendet werden.')
  })
})
