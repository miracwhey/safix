import type { Invoice } from './types'
import { generateInvoicePdf } from './artifactGenerator'
import { isNative } from '../platform'

/**
 * Triggers a PDF download or native share for the given invoice.
 *
 * Web:
 *   Creates an object URL, clicks a hidden anchor — browser saves the file.
 *
 * Native (Capacitor iOS/Android):
 *   1. Writes the PDF to the device cache directory via @capacitor/filesystem.
 *      (Cache directory requires no storage permissions on iOS/Android.)
 *   2. Opens the system share sheet via @capacitor/share so the craftsman
 *      can save to Files, share via AirDrop/WhatsApp/email, print, or any
 *      other available share target.
 *
 *   This is the standard iOS/Android "export document" UX — the craftsman
 *   has full control over where the file ends up. No data: URL workaround.
 *
 * Does NOT mark the invoice as sent. Export/download and sent are separate
 * explicit craftsman actions. No implicit sent side-effect.
 *
 * Throws if:
 *   - The invoice is a draft, missing required fields, or holds placeholder data
 *     (from generateInvoicePdf — propagated to caller for visible error handling)
 *   - Native filesystem write fails
 *   - Native share sheet is unavailable
 */
export async function downloadInvoicePdf(invoice: Invoice): Promise<void> {
  const blob = await generateInvoicePdf(invoice)
  const filename = `Rechnung_${invoice.invoiceNumber || invoice.id}.pdf`

  if (isNative()) {
    await exportNative(blob, filename)
  } else {
    downloadWeb(blob, filename)
  }
}

// ── Web delivery ──────────────────────────────────────────────────────────────

/**
 * Web: creates an object URL and clicks a hidden anchor.
 * The browser prompts the user to save the PDF.
 */
function downloadWeb(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Delay revocation so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 250)
}

// ── Native delivery ───────────────────────────────────────────────────────────

/**
 * Converts a Blob to a base64 string.
 * Uses chunked fromCharCode calls to avoid call-stack overflow for any
 * practical PDF size (chunked at 8 KiB — safe for invoices of any size).
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)) as number[],
    )
  }
  return btoa(binary)
}

/**
 * Native: writes the PDF to the cache directory and opens the share sheet.
 *
 * Dynamically imports @capacitor/filesystem and @capacitor/share so the
 * web bundle does not pull in Capacitor native code.
 */
async function exportNative(blob: Blob, filename: string): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')

  const base64 = await blobToBase64(blob)

  const writeResult = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  })

  await Share.share({
    title: filename,
    files: [writeResult.uri],
    dialogTitle: 'Rechnung teilen oder speichern',
  })
}
