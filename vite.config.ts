import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'

/**
 * One release name for every build channel, used for BOTH the runtime tag
 * (`define.__SENTRY_RELEASE__` → Sentry.init) and the sourcemap upload
 * (`sentryVitePlugin.release.name`). They MUST be identical or uploaded maps
 * never attach to the events the SDK reports.
 *
 * Priority:
 *   1. VERCEL_GIT_COMMIT_SHA — Vercel web builds (existing scheme, unchanged).
 *   2. SENTRY_RELEASE        — explicit override for scripted/CI builds.
 *   3. local `git rev-parse HEAD` — native/local builds (`npm run build` +
 *      `cap sync ios`). Same commit-sha scheme as Vercel, so a native bundle
 *      built from a deployed commit reuses the maps that build uploaded.
 *      Without this fallback the native runtime fell back to
 *      @sentry/capacitor's default release (`app.fixup.main@1.0.0+2`), which
 *      never has sourcemaps — Sentry FIXUP-WEB-6Q stacks were minified-only.
 *   4. '' — no git available (release omitted at runtime, plugin disabled).
 */
function resolveSentryRelease(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA
  if (process.env.SENTRY_RELEASE) return process.env.SENTRY_RELEASE
  try {
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const sentryRelease = resolveSentryRelease()

export default defineConfig({
  // .claude (Agent-Worktrees, 190k+ Dateien) aus dem Dev-Watcher halten —
  // sonst EMFILE auf macOS (Default-FD-Limit) und zaeher HMR-Start.
  server: {
    watch: {
      ignored: ['**/.claude/**', '**/ios/**', '**/e2e/test-results/**', '**/e2e/playwright-report/**'],
    },
    // E2E-Harness (Layer 1): Vite servt das Frontend, vercel dev (Port 3211)
    // nur die /api-Functions — vercel dev allein kann das Vite-Frontend nicht
    // serven (SPA-Catch-all-Rewrite aus vercel.json frisst die Dev-Pfade
    // /@vite/* und /src/* → 500). Im normalen Dev-Betrieb ist der Proxy inert:
    // VITE_API_BASE_URL zeigt dort absolut auf das Prod-Deployment.
    proxy: {
      '/api': 'http://localhost:3211',
    },
  },
  plugins: [
    react(),
    // -----------------------------------------------------------------------
    // M10 — PWA service-worker read-cache.
    //
    // Two runtime caches:
    //   1. Supabase Storage media objects (cross-origin) — CacheFirst, so a
    //      photo the user has already loaded once stays viewable when the
    //      device drops offline. Important for the worker-doku flow where a
    //      craftsman opens a job page on a baustelle to consult earlier
    //      photos.
    //   2. /api/* GET responses (cross-origin in Capacitor native; same-origin
    //      on web) — NetworkFirst with a 5s timeout, so a flaky connection
    //      still feels responsive instead of hanging.
    //
    // Capacitor caveat:
    //   Service-worker support inside WKWebView under the `capacitor://`
    //   scheme is unreliable across iOS versions. The web (Vercel) build is
    //   the primary target for this layer; if Capacitor decides to register
    //   the worker it is a bonus, but native iOS offline coverage will need a
    //   dedicated IndexedDB-blob cache in a follow-up block.
    // -----------------------------------------------------------------------
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      injectRegister: 'auto',
      includeAssets: ['fixup-icon.svg'],
      manifest: {
        name: 'SaFix — Handwerker Plattform',
        short_name: 'SaFix',
        description: 'Finde schnell und sicher Handwerker in deiner Nähe',
        theme_color: '#2563EB',
        background_color: '#F5F6FA',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'de',
        icons: [
          {
            src: 'fixup-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // Skip the global precache catch-all so production builds do not
        // accidentally ship the entire bundle as inert cache entries on
        // capacitor://. Only runtime caches matter for the read-cache use
        // case below.
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,webp,woff2}'],
        // Never precache the Spatial 3D asset pipeline — PBR textures, HDRI
        // EXRs and GLB models under public/spatial-assets/ are large
        // (multi-MB) on-demand binaries the 3D viewer fetches itself. They
        // must stay out of the SW precache or workbox aborts the build on
        // the file-size ceiling.
        globIgnores: ['**/spatial-assets/**'],
        // Ignore the largest chunks so the precache stays under the default
        // 2 MB ceiling — the LARGE app bundle is downloaded on first paint
        // anyway.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Skip routes that should always hit the network even after install.
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Supabase Storage media bucket — public assets, safe to cache
            // long-term. The pre-upload pipeline already strips EXIF before
            // anything reaches storage, so cached objects do not leak more
            // metadata than the live URL would.
            urlPattern: ({ url }) =>
              /\.supabase\.co$/.test(url.hostname) &&
              url.pathname.includes('/storage/v1/object/public/media/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'fixup-media-v1',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // /api/* GET responses — short TTL so stale data surfaces only
            // when the network is truly unavailable. POST/PUT/DELETE bypass
            // the cache automatically (Workbox default).
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              url.pathname.startsWith('/api/') &&
              !url.pathname.includes('webhook'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fixup-api-get-v1',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 40,
                maxAgeSeconds: 5 * 60, // 5 min
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Disabled in dev — the constant SW invalidation noise is more
        // confusing than useful, and Vite already serves fresh modules.
        enabled: false,
        type: 'module',
      },
    }),
    // -----------------------------------------------------------------------
    // Sentry sourcemap upload + release association.
    //
    // Only active when SENTRY_AUTH_TOKEN is present (Vercel build env, or a
    // local native-bundle build run with the token exported — see
    // resolveSentryRelease above). Without the token the build is a silent
    // no-op (`disable: true`) — no network, no failure, CI/local unchanged.
    //
    // The `release.name` MUST equal __SENTRY_RELEASE__ set in `define` below
    // and consumed by src/lib/sentry.ts, so uploaded maps attach to the same
    // release the runtime SDK tags events with. Both read `sentryRelease`.
    //
    // Must run last in the array (after VitePWA) so it processes the final
    // emitted bundle.
    // -----------------------------------------------------------------------
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: sentryRelease || undefined,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
      telemetry: false,
    }),
  ],
  base: '/',
  build: {
    // Emit hidden sourcemaps ONLY when @sentry/vite-plugin will upload them
    // (token present): `hidden` = no `//# sourceMappingURL=` comment on the
    // shipped JS, and `filesToDeleteAfterUpload` (above) removes the maps
    // from dist/ after upload. Without the token, maps are not generated at
    // all — previously they were emitted into dist/ and `cap sync` copied
    // them (source code included) into the native app bundle.
    sourcemap: process.env.SENTRY_AUTH_TOKEN ? 'hidden' : false,
    // Split heavy, statically-imported node_modules vendors out of the single
    // ~2.11MB main entry into separate, long-term-cacheable chunks so an
    // app-code change no longer busts the vendor cache. App code stays in the
    // entry; everything NOT named below keeps Rollup's automatic splitting so
    // dynamically-imported heavy deps (three.js, @model-viewer, heic2any,
    // meshopt) stay in their own lazy chunks instead of an eager catch-all.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return // app code stays in the entry
          // React ecosystem MUST stay together (hooks/runtime/scheduler) or
          // you get "Invalid hook call".
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|use-sync-external-store)[\\/]/.test(id))
            return 'vendor-react'
          if (id.includes('@supabase')) return 'vendor-supabase'
          if (id.includes('@sentry')) return 'vendor-sentry'
          // jspdf is NOT named: it is now imported dynamically (await import) by
          // every PDF generator, so Rollup's default splitting gives it its own
          // lazy chunk loaded only on first PDF export. Naming it here made it an
          // eager `vendor-pdf` chunk that also carried the shared vite-preload
          // helper → modulepreloaded into index.html, defeating the deferral.
          // No catch-all: returning a name here would pull lazy heavy deps into
          // one eager chunk and defeat their on-demand loading.
        },
      },
    },
  },
  define: {
    // Build-time constants consumed by src/lib/sentry.ts. The release MUST
    // stay in lockstep with the plugin's `release.name` above — both read
    // `sentryRelease`. A non-empty value on native builds keeps the runtime
    // from falling back to @sentry/capacitor's `app.fixup.main@…` default,
    // which has no sourcemaps.
    __SENTRY_RELEASE__: JSON.stringify(sentryRelease),
    __SENTRY_ENVIRONMENT__: JSON.stringify(process.env.VERCEL_ENV ?? 'development'),
  },
})
