import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadWithRetry } from '../../src/lib/chat/uploadWithRetry'
import { ChatStorageUploadError } from '../../src/lib/chat/errors'

// jsdom defaults navigator.onLine to false, which would make uploadWithRetry
// throw OfflineError before the retry classifier runs. Force "online" so these
// tests exercise the ChatStorageUploadError path, not the offline guard.
beforeEach(() => {
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  }
})

// Batch 1B: a Storage 4xx (mime not allowed / too large / unsupported) is a
// permanent rejection. Before the fix, uploadWithRetry treated it as transient
// and burned ~7s of spinner across 3 attempts before failing. These lock in
// the fail-fast classification against the REAL uploadWithRetry (the chatWorkflow
// suite mocks it away, so this is the only place the classifier is exercised).

describe('uploadWithRetry — ChatStorageUploadError classification', () => {
  it('does NOT retry a 400 mime/format rejection — fail fast', async () => {
    const fn = vi.fn().mockRejectedValue(new ChatStorageUploadError('nope', { status: 400 }))
    await expect(
      uploadWithRetry(fn, { maxAttempts: 3, delays: [0, 0, 0] }),
    ).rejects.toBeInstanceOf(ChatStorageUploadError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry 413 (too large) or 415 (unsupported media)', async () => {
    for (const status of [413, 415]) {
      const fn = vi.fn().mockRejectedValue(new ChatStorageUploadError('nope', { status }))
      await expect(uploadWithRetry(fn, { maxAttempts: 3, delays: [0, 0, 0] })).rejects.toBeTruthy()
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  it('DOES retry 5xx, 408, 429 and network (status 0)', async () => {
    for (const status of [500, 408, 429, 0]) {
      const fn = vi.fn().mockRejectedValue(new ChatStorageUploadError('transient', { status }))
      await expect(uploadWithRetry(fn, { maxAttempts: 2, delays: [0, 0] })).rejects.toBeTruthy()
      expect(fn).toHaveBeenCalledTimes(2)
    }
  })

  it('resolves without retry on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(uploadWithRetry(fn, { maxAttempts: 3, delays: [0, 0, 0] })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
