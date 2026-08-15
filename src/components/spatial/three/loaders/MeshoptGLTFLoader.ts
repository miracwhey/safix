/**
 * Spatial Core · Block E2 · GLTFLoader factory (Meshopt + KTX2)
 *
 * The Block X convert pipeline emits glTF with Meshopt-compressed geometry
 * and KTX2-encoded textures (D15). Three.js cannot deserialise either out
 * of the box — both decoders must be wired into the loader before the
 * first glb fetch.
 *
 *   * `MeshoptDecoder` ships as a WASM-backed JS module inside the
 *     `three` package — bundled by Vite directly, no public-folder copy
 *     required.
 *   * `KTX2Loader` needs the Basis Universal transcoder (a `.js` + `.wasm`
 *     pair). We serve those from a CDN pinned to the same three version
 *     as the SDK to avoid version skew. Self-hosting these two files
 *     is a V1.5 hardening task (see Block J notes).
 *
 * The KTX2 loader is created once per `WebGLRenderer` because
 * `detectSupport(renderer)` mutates internal browser-capability state on
 * the renderer instance. Re-creating it on every model load is what the
 * three.js examples do, but for a single static scene we keep one loader
 * per renderer to avoid the WASM warm-up.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { WebGLRenderer } from 'three'

/**
 * Self-hosted basis transcoder path — files live under `public/spatial-basis/`
 * and are mirrored from `node_modules/three/examples/jsm/libs/basis/` at
 * install time. Self-hosting matters for two reasons:
 *
 *   1. The Capacitor iOS WKWebView ships with a default CSP that blocks
 *      cross-origin script fetches (`connect-src 'self'`), so a CDN URL
 *      would silently fail to load the transcoder and KTX2 textures would
 *      render as black.
 *   2. Offline-first behaviour — a craftsman opening a previously-fetched
 *      scan on a baustelle without coverage still gets the model textured.
 *
 * Refresh after a `three` upgrade with `npm run spatial:sync-basis`. The
 * basis files are committed to keep the install zero-config.
 */
const BASIS_TRANSCODER_PATH = '/spatial-basis/'

const ktx2LoaderByRenderer = new WeakMap<WebGLRenderer, KTX2Loader>()

export function getSpatialKtx2Loader(renderer: WebGLRenderer): KTX2Loader {
  const cached = ktx2LoaderByRenderer.get(renderer)
  if (cached) return cached
  const loader = new KTX2Loader()
  loader.setTranscoderPath(BASIS_TRANSCODER_PATH)
  loader.detectSupport(renderer)
  ktx2LoaderByRenderer.set(renderer, loader)
  return loader
}

/**
 * Apply Meshopt + KTX2 decoders onto an existing `GLTFLoader` instance.
 * Used as the `extensions` callback passed to r3f's `useLoader(GLTFLoader, ...)`
 * so we don't fight react-three-fiber's loader cache.
 */
export function applySpatialDecoders(loader: GLTFLoader, renderer: WebGLRenderer): void {
  loader.setKTX2Loader(getSpatialKtx2Loader(renderer))
  loader.setMeshoptDecoder(MeshoptDecoder)
}

/** Standalone factory — convenient for non-r3f call sites (PDF screenshot,
 *  worker preload). r3f scenes should prefer `applySpatialDecoders`. */
export function makeSpatialGltfLoader(renderer: WebGLRenderer): GLTFLoader {
  const loader = new GLTFLoader()
  applySpatialDecoders(loader, renderer)
  return loader
}

/** Cleanup hook for renderer dispose — release the WASM-backed transcoder. */
export function disposeSpatialLoaders(renderer: WebGLRenderer): void {
  const loader = ktx2LoaderByRenderer.get(renderer)
  if (loader) {
    loader.dispose()
    ktx2LoaderByRenderer.delete(renderer)
  }
}
