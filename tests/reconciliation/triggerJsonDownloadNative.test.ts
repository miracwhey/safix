/**
 * Block N13.CAP-EXPORT — `triggerJsonDownload` must surface a Capacitor
 * share sheet on iOS / Android instead of relying on the web `<a download>`
 * attribute (which the WKWebView routinely ignores, leaving the user with
 * an inline JSON view and no save option).
 *
 * Mirrors the `downloadInvoicePdf` pattern in
 * `src/lib/invoices/downloadInvoice.ts` — Filesystem.writeFile to the
 * cache directory, then Share.share with the resulting file URI.
 *
 * The web path is the existing Blob+anchor flow. We don't re-test that
 * here (it's covered by the prior `triggerJsonDownload` integration in
 * exportDispute.test.ts) — this suite locks the native branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const writeFileMock = vi.fn(async ({ path }: { path: string }) => ({
  uri: `file:///cache/${path}`,
}))
const shareMock = vi.fn(async () => ({ activityType: 'mock' }))
const isNativeMock = vi.fn(() => false)

vi.mock('../../src/lib/platform', () => ({
  isNative: () => isNativeMock(),
}))

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: writeFileMock },
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}))

vi.mock('@capacitor/share', () => ({
  Share: { share: shareMock },
}))

import { triggerJsonDownload } from '../../src/lib/reconciliation/export/triggerDownload'

beforeEach(() => {
  writeFileMock.mockClear()
  shareMock.mockClear()
  isNativeMock.mockReset()
})

describe('triggerJsonDownload — native (Capacitor)', () => {
  it('writes the JSON to the cache directory as UTF-8', async () => {
    isNativeMock.mockReturnValue(true)
    await triggerJsonDownload('export-2026-05-03.json', '{"hello":"world"}')

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    expect(writeFileMock).toHaveBeenCalledWith({
      path: 'export-2026-05-03.json',
      data: '{"hello":"world"}',
      directory: 'CACHE',
      encoding: 'utf8',
    })
  })

  it('opens the share sheet with the cache file URI after writing', async () => {
    isNativeMock.mockReturnValue(true)
    await triggerJsonDownload('akz-2026-001-export.json', '[]')

    expect(shareMock).toHaveBeenCalledTimes(1)
    expect(shareMock).toHaveBeenCalledWith({
      title: 'akz-2026-001-export.json',
      files: ['file:///cache/akz-2026-001-export.json'],
      dialogTitle: 'Datenexport teilen oder speichern',
    })
  })

  it('preserves call order: writeFile resolves before share is invoked', async () => {
    isNativeMock.mockReturnValue(true)
    const order: string[] = []
    writeFileMock.mockImplementationOnce(async ({ path }: { path: string }) => {
      order.push('write')
      return { uri: `file:///cache/${path}` }
    })
    shareMock.mockImplementationOnce(async () => {
      order.push('share')
      return { activityType: 'mock' }
    })

    await triggerJsonDownload('order.json', '{}')
    expect(order).toEqual(['write', 'share'])
  })
})

describe('triggerJsonDownload — web fallback', () => {
  it('does NOT call Filesystem or Share when isNative() is false', async () => {
    isNativeMock.mockReturnValue(false)
    // jsdom provides document + window in the vitest config.
    await triggerJsonDownload('web.json', '{}')
    expect(writeFileMock).not.toHaveBeenCalled()
    expect(shareMock).not.toHaveBeenCalled()
  })
})
