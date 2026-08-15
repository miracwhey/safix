/**
 * Browser- and native-side download trigger for the DSGVO Art. 15
 * dispute exports. Two delivery paths share the same call site:
 *
 * Web (browser / PWA):
 *   Creates a Blob, opens an object URL, clicks a hidden anchor — the
 *   browser saves the JSON via its standard download dialog.
 *
 * Native (Capacitor iOS / Android):
 *   1. Writes the JSON to the device cache directory via
 *      @capacitor/filesystem (Cache requires no storage permissions on
 *      iOS/Android).
 *   2. Opens the system share sheet via @capacitor/share so the user
 *      can save to Files, send via Mail / WhatsApp / AirDrop, etc.
 *
 *   Mirrors the pattern from `src/lib/invoices/downloadInvoice.ts` —
 *   the WKWebView on iOS commonly ignores the `download` attribute on
 *   web anchors and renders the JSON inline, leaving the customer with
 *   no straightforward way to keep the file. The share-sheet path
 *   solves that.
 *
 * Side-effecting on purpose — never call from a pure selector. Mounted
 * components invoke this from a click handler.
 *
 * Returns a Promise so native callers can await; the web path resolves
 * synchronously after starting the download.
 */

import { isNative } from '../../platform'

export async function triggerJsonDownload(
  filename: string,
  content: string,
): Promise<void> {
  if (isNative()) {
    await exportNative(filename, content)
    return
  }
  downloadWeb(filename, content)
}

// ── Web delivery ─────────────────────────────────────────────────────────────

function downloadWeb(filename: string, content: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Defer revoke so Safari can complete the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

// ── Native delivery ──────────────────────────────────────────────────────────

/**
 * Native: writes the JSON to the cache directory and opens the share sheet.
 *
 * Dynamically imports @capacitor/filesystem and @capacitor/share so the
 * web bundle does not pull in Capacitor native code.
 */
async function exportNative(filename: string, content: string): Promise<void> {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')

  const writeResult = await Filesystem.writeFile({
    path: filename,
    data: content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  })

  await Share.share({
    title: filename,
    files: [writeResult.uri],
    dialogTitle: 'Datenexport teilen oder speichern',
  })
}
