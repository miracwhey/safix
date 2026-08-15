import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Native and package build outputs contain copied/generated JavaScript (for
  // example Capacitor's `native-bridge.js`). They are git-ignored, so a fresh
  // CI checkout never sees them, while a local `eslint .` otherwise lints them
  // and can fail on rule directives for plugins that are not loaded for JS.
  // Keep the local gate scoped to authored source just like CI.
  globalIgnores([
    'dist',
    '.claude/',
    '**/build/**',
    '**/DerivedData/**',
    '**/.build/**',
    '**/*.xcarchive/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Allow intentionally-unused parameters to be prefixed with '_'
      // (e.g. interface-satisfying stubs in InMemory/Mock providers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Build-gap guard (feedback_capacitor_share_origin): in the Capacitor
      // native shell `window.location.origin` resolves to `capacitor://localhost`,
      // which is meaningless to any external receiver and silently breaks
      // share / auth-redirect / Stripe return_url links. The canonical helper
      // `getPublicWebOrigin()` in `@/lib/platform` returns the hosted PWA origin
      // on native and the live origin on web — always use it. The helper file
      // itself is exempted below via a files-override.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='origin'][object.type='MemberExpression'][object.property.name='location'][object.object.name='window']",
          message:
            "Use getPublicWebOrigin() from '@/lib/platform' instead of window.location.origin — in the Capacitor native shell it is 'capacitor://localhost' and breaks share/redirect/return URLs (build-gap: feedback_capacitor_share_origin).",
        },
      ],
    },
  },
  {
    // The platform helper IS the canonical wrapper that legitimately reads
    // `window.location.origin` on the web path (getPublicWebOrigin /
    // getAuthRedirectUrl). Exempt it from the build-gap guard it backs.
    files: ['src/lib/platform.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // CRIT-1 audit-fix: prevent Block-A spatial barrels from wildcard-re-exporting
    // the canonical L1 surface. `AnchorUv` exists in both worlds with different
    // shapes; a `export * from './canonical'` would silently first-export-wins.
    // Canonical types must be consumed via deep-path imports
    // (`@/lib/spatial/canonical/...` or relative `./canonical/...`).
    files: ['src/lib/spatial/index.ts', 'src/lib/spatial/types.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                './canonical',
                './canonical/index',
                './canonical/types',
                '@/lib/spatial/canonical',
                '@/lib/spatial/canonical/index',
                '@/lib/spatial/canonical/types',
              ],
              message:
                'Canonical L1 must not be re-exported from Block-A barrels (CRIT-1 name-collision risk on AnchorUv et al). Consume via deep paths like `@/lib/spatial/canonical/types/annotations`.',
            },
          ],
        },
      ],
    },
  },
])
