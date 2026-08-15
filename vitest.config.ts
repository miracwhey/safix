import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Component tests (.test.tsx) use JSX — the automatic runtime matches the
  // app source (no explicit React import needed).
  esbuild: {
    jsx: 'automatic',
  },
  define: {
    // Provide placeholder Supabase credentials so the client can be
    // constructed without network access during tests. All tests use
    // InMemory repositories so the client is never actually called.
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://placeholder.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('placeholder-anon-key'),
    'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('in-memory'),
    // Tests run without a deployed API origin — relative paths required.
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(''),
    'import.meta.env.VITE_CHAT_UI_CUTOVER_CUSTOMER': JSON.stringify('false'),
    'import.meta.env.VITE_CHAT_UI_CUTOVER_CRAFTSMAN': JSON.stringify('false'),
    'import.meta.env.VITE_CHAT_UI_CUTOVER_WORKER': JSON.stringify('false'),
    // Sentry build-time constants (see vite.config.ts)
    __SENTRY_RELEASE__: JSON.stringify(''),
    __SENTRY_ENVIRONMENT__: JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    globals: true,
    // `.test.tsx` is scoped to the spatial tree on purpose: 3 pre-existing
    // orphaned .test.tsx files elsewhere were never in the glob and one is
    // currently failing — widening the glob globally is out of scope here.
    // Both spatial subtrees (`lib/spatial` + `components/spatial`) are in
    // scope — Phase-2 edit-mode component tests live under `components/spatial`.
    include: [
      'tests/**/*.test.ts',
      'tests/lib/spatial/**/*.test.tsx',
      'tests/components/spatial/**/*.test.tsx',
    ],
    setupFiles: ['tests/helpers/setup.ts'],
    testTimeout: 15000,
  },
})
