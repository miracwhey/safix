/**
 * Shared PDF delivery — web download vs native (Capacitor) share sheet.
 *
 * The offer + invoice generators each carried their own copy of this logic
 * (blobToBase64 + Filesystem.writeFile → Share.share on native, hidden-anchor
 * download on web). New artifact PDFs (change_order …) build on THIS helper so
 * the delivery path is written once. Offer/invoice keep their device-tested
 * copies for now; they can be migrated onto this incrementally.
 */

import { isNative } from '../platform'

/** Chunked Blob → base64 (8 KiB chunks · call-stack-safe for any PDF size). */
export async function blobToBase64(blob: Blob): Promise<string> {
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
 * Hand a generated PDF blob to the platform:
 *   - Native (Capacitor iOS/Android): write to Directory.Cache (no permission
 *     needed) and open the system share sheet — save to Files, AirDrop,
 *     WhatsApp, email, print, …
 *   - Web: hidden-anchor download.
 *
 * Does NOT mark anything sent — export is a separate explicit action.
 */
export async function shareOrDownloadPdf(
  blob: Blob,
  filename: string,
  dialogTitle: string,
): Promise<void> {
  if (isNative()) {
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
      dialogTitle,
    })
    return
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 250)
}
