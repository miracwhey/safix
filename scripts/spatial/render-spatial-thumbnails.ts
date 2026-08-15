/**
 * Spatial · Phase 1 · Headless GLB → JPG thumbnail renderer.
 *
 * Renders every published GLB catalog asset to a 512×512 JPEG thumbnail under
 * `public/spatial-assets/thumbnails/{slug}.jpg` — the path the catalog's
 * `thumbnailStoragePath` already points to. The existing
 * `scripts/upload-spatial-public-assets.ts` then ships them to the
 * `spatial-public-assets` bucket (they live under the walked tree).
 *
 * Approach (per render-tool decision 2026-05-29): a tiny static server serves
 * the local GLBs + a standalone three.js harness page; Playwright (headless
 * Chromium, real WebGL) loads each GLB, frames it with a neutral 3/4 studio
 * shot, and screenshots the canvas as JPEG. No app / vite needed.
 *
 * Run:
 *   npx tsx scripts/spatial/render-spatial-thumbnails.ts            # all published GLB
 *   npx tsx scripts/spatial/render-spatial-thumbnails.ts furn-sofa-3seater-fabric-grey   # one slug
 *
 * Output is local only — review the JPEGs, then upload with:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/upload-spatial-public-assets.ts --execute
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { chromium } from 'playwright'
import { ASSET_CATALOG } from '../../src/lib/spatial/canonical/catalog/asset-catalog.ts'

/** Properties the in-page three.js harness stamps on `window` (signals readiness
 *  / error to the Playwright driver). Typed cast instead of `any` for lint. */
type HarnessWindow = { __ready?: boolean; __error?: string }

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const PUBLIC = join(ROOT, 'public')
const THUMB_DIR = join(PUBLIC, 'spatial-assets', 'thumbnails')
const THREE_BUILD_DIR = join(ROOT, 'node_modules', 'three', 'build')
const THREE_JSM = join(ROOT, 'node_modules', 'three', 'examples', 'jsm')
const SIZE = 512

const onlySlugs = process.argv.slice(2)

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html',
  '.json': 'application/json',
}

const HARNESS = /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#eef1f6;overflow:hidden}
  #c{width:${SIZE}px;height:${SIZE}px;display:block}
</style>
<script type="importmap">
{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/jsm/"}}
</script></head>
<body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const params = new URLSearchParams(location.search)
const glb = params.get('glb')

const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(2)
renderer.setSize(${SIZE}, ${SIZE}, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05

const scene = new THREE.Scene()
scene.background = new THREE.Color('#eef1f6')

// Neutral studio lighting.
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bdc9, 1.1))
const key = new THREE.DirectionalLight(0xffffff, 2.0)
key.position.set(3, 5, 4)
scene.add(key)
const fill = new THREE.DirectionalLight(0xffffff, 0.7)
fill.position.set(-4, 2, -2)
scene.add(fill)

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100)

function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5
  // 3/4 iso direction.
  const dir = new THREE.Vector3(1, 0.72, 1).normalize()
  const fov = (camera.fov * Math.PI) / 180
  const dist = (radius / Math.sin(fov / 2)) * 1.35
  camera.position.copy(center).addScaledVector(dir, dist)
  camera.lookAt(center)
  camera.updateProjectionMatrix()
}

const loader = new GLTFLoader()
loader.load(
  glb,
  (gltf) => {
    scene.add(gltf.scene)
    frameObject(gltf.scene)
    renderer.render(scene, camera)
    requestAnimationFrame(() => {
      renderer.render(scene, camera)
      window.__ready = true
    })
  },
  undefined,
  (err) => { window.__error = String(err && err.message || err) },
)
</script>
</body></html>`

function serveFile(res: ServerResponse, abs: string): void {
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
  res.end(readFileSync(abs))
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/' || url === '/harness') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(HARNESS)
    return
  }
  if (url.startsWith('/vendor/build/')) return serveFile(res, join(THREE_BUILD_DIR, url.slice('/vendor/build/'.length)))
  if (url.startsWith('/vendor/jsm/')) return serveFile(res, join(THREE_JSM, url.slice('/vendor/jsm/'.length)))
  if (url.startsWith('/spatial-assets/')) return serveFile(res, join(PUBLIC, url.slice(1)))
  res.writeHead(404)
  res.end('not found')
}

async function main(): Promise<void> {
  mkdirSync(THUMB_DIR, { recursive: true })

  let assets = ASSET_CATALOG.filter(
    (a) => a.geometryKind === 'glb' && a.published && a.gltfStoragePath,
  )
  if (onlySlugs.length) assets = assets.filter((a) => onlySlugs.includes(a.slug))

  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`

  console.log(`\nRendering ${assets.length} thumbnails → ${THUMB_DIR}\n`)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 })

  let ok = 0
  let fail = 0
  for (const a of assets) {
    const glbUrl = `/${a.gltfStoragePath}` // 'spatial-assets/models/{slug}.glb'
    try {
      await page.goto(`${base}/harness?glb=${encodeURIComponent(glbUrl)}`, { waitUntil: 'load' })
      await page.waitForFunction(() => (window as unknown as HarnessWindow).__ready === true || (window as unknown as HarnessWindow).__error, null, {
        timeout: 15000,
      })
      const err = await page.evaluate(() => (window as unknown as HarnessWindow).__error)
      if (err) throw new Error(err)
      const canvas = page.locator('#c')
      const buf = await canvas.screenshot({ type: 'jpeg', quality: 86 })
      writeFileSync(join(THUMB_DIR, `${a.slug}.jpg`), buf)
      ok++
      console.log(`  ✓ ${a.slug}.jpg`)
    } catch (e) {
      fail++
      console.error(`  ✗ ${a.slug} — ${(e as Error).message}`)
    }
  }

  await browser.close()
  server.close()
  console.log(`\nDone. ${ok} rendered, ${fail} failed → ${THUMB_DIR}`)
  if (fail > 0) process.exitCode = 1
}

void main()
