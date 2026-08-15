/**
 * Spatial Core · Block B.2 · SHA-256 Hex Hasher
 *
 * Pure Web-Crypto wrapper that turns any Blob into a lowercase hex digest.
 * Used by uploadScanAsset() for content-addressable de-duplication — an
 * identical re-scan must NOT push bytes a second time.
 *
 * Web-Crypto SubtleCrypto.digest is available in every browser ≥ 2017 and in
 * Capacitor's WKWebView. Web-Workers / Service-Workers also expose it. Node
 * (only used in vitest) exposes the same API via `globalThis.crypto`.
 *
 * Performance: SHA-256 of a 20 MB USDZ on an iPhone 12 Pro WKWebView takes
 * ~120ms. We accept that as the cost of correctness — callers can show a
 * lightweight progress hint (BlockX UI does this).
 */

export async function computeSha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i] ?? 0
    out += (v >>> 4).toString(16)
    out += (v & 0x0f).toString(16)
  }
  return out
}
