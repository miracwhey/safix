#!/bin/bash
# Xcode Cloud post-clone hook.
#
# Responsibility:
#   1. Ensure node/npm are available
#   2. Install JS deps deterministically (npm ci)
#   3. Build the SPA bundle (npm run build → dist/)
#   4. Sync the web bundle into the iOS native target (cap copy ios)
#   5. Fail loudly with FATAL: prefix at any broken step
#
# Notes:
#   - iOS native deps are managed via Swift Package Manager (CapApp-SPM),
#     not CocoaPods. Plugin Swift packages reference node_modules paths,
#     so `npm ci` already makes plugin sources available. We therefore
#     run `cap copy ios` (web-asset sync only), not `cap sync ios`.
#   - set -Eeuo pipefail: abort on any non-zero, unset var, or pipe failure.
#   - Use ${VAR:-default} for variables that may legitimately be unset
#     (e.g. CI_PRIMARY_REPOSITORY_PATH outside Xcode Cloud).

set -Eeuo pipefail

# ── PATH ──────────────────────────────────────────────────────────────────────
# Homebrew Apple Silicon, Homebrew Intel, system bins
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${PATH:-}"

echo "=== PATH ==="
echo "$PATH"

# Stable Homebrew env (no auto-update / no analytics)
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_ANALYTICS=1

# ── Node 24 / npm detection ───────────────────────────────────────────────────
# Keep Xcode Cloud on the same major pinned in package.json and Vercel. Merely
# declaring `engines.node=24.x` is not enough: npm only warns and will otherwise
# build with whichever preinstalled Homebrew Node happens to be newest.
echo "=== Node 24 detection ==="
REQUIRED_NODE_MAJOR="24"

node_major_at() {
    "$1/node" -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}

use_node_24_at() {
    candidate="$1"
    if [ -z "$candidate" ] || [ ! -x "$candidate/node" ]; then
        return 1
    fi
    if [ "$(node_major_at "$candidate")" != "$REQUIRED_NODE_MAJOR" ]; then
        return 1
    fi
    export PATH="$candidate:$PATH"
    hash -r
    echo "Node 24 found at $candidate"
    return 0
}

NODE_24_READY=""
if command -v node > /dev/null 2>&1 && [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)" = "$REQUIRED_NODE_MAJOR" ]; then
    echo "Node 24 already active: $(command -v node)"
    NODE_24_READY="1"
else
    if command -v node > /dev/null 2>&1; then
        echo "Active Node $(node -v) does not match required major 24 — checking pinned locations"
    else
        echo "Node not in PATH — checking pinned locations"
    fi

    NVM_NODE_24=""
    if [ -d "${HOME:-}/.nvm/versions/node" ]; then
        NVM_NODE_24="$(find "${HOME}/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v24.*' 2>/dev/null | sort -V | tail -1 || true)"
        if [ -n "$NVM_NODE_24" ]; then
            NVM_NODE_24="$NVM_NODE_24/bin"
        fi
    fi

    for candidate in \
        "${FIXUP_NODE_24_BIN:-}" \
        "$NVM_NODE_24" \
        "/opt/homebrew/opt/node@24/bin" \
        "/usr/local/opt/node@24/bin"; do
        if use_node_24_at "$candidate"; then
            NODE_24_READY="1"
            break
        fi
    done
fi

if [ -z "$NODE_24_READY" ]; then
    echo "Node 24 not found — attempting brew install node@24"
    if ! command -v brew > /dev/null 2>&1; then
        echo "FATAL: brew not found. Cannot install required Node 24. Aborting."
        exit 1
    fi
    echo "brew found: $(command -v brew)"
    if ! brew install node@24; then
        echo "FATAL: brew install node@24 failed. Check brew logs above."
        exit 1
    fi
    BREW_NODE_24_BIN="$(brew --prefix node@24)/bin"
    if ! use_node_24_at "$BREW_NODE_24_BIN"; then
        echo "FATAL: node@24 installed but Node 24 is still unavailable. Aborting."
        exit 1
    fi
fi

if ! command -v node > /dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)" != "$REQUIRED_NODE_MAJOR" ]; then
    echo "FATAL: active Node must be 24.x for App Store builds. Aborting."
    exit 1
fi

if ! command -v npm > /dev/null 2>&1; then
    echo "FATAL: npm not found (node is $(node -v) but npm missing). Aborting."
    exit 1
fi

echo "=== pinned Node/npm versions ==="
node -v
npm -v

# ── repo root ─────────────────────────────────────────────────────────────────
echo "=== Resolving repo root ==="
# Xcode Cloud sets CI_PRIMARY_REPOSITORY_PATH; locally we derive from script path.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
echo "REPO_ROOT=$REPO_ROOT"

if [ ! -d "$REPO_ROOT" ]; then
    echo "FATAL: REPO_ROOT '$REPO_ROOT' does not exist. Aborting."
    exit 1
fi

cd "$REPO_ROOT"
echo "Working directory: $(pwd)"

# ── package-lock.json ─────────────────────────────────────────────────────────
echo "=== Checking package-lock.json ==="
if [ ! -f "package-lock.json" ]; then
    echo "FATAL: package-lock.json missing in $(pwd). npm ci requires it. Aborting."
    exit 1
fi
echo "package-lock.json found"

# ── npm ci ────────────────────────────────────────────────────────────────────
echo "=== npm ci ==="
if ! npm ci; then
    echo "FATAL: npm ci failed in $(pwd). Check npm output above."
    exit 1
fi

# ── verify @capacitor packages ────────────────────────────────────────────────
echo "=== @capacitor packages ==="
if [ ! -d "node_modules/@capacitor" ]; then
    echo "FATAL: node_modules/@capacitor missing after npm ci. Aborting."
    exit 1
fi
ls node_modules/@capacitor

# ── production env-var validation ─────────────────────────────────────────────
# These must be present BEFORE npm run build so Vite inlines their values into
# the bundle. Missing vars produce a runtime startup error on the device
# (see src/lib/env/envValidation.ts: validateClientEnvWith).
echo "=== Production env-var validation ==="

# Local devs may keep secrets in $REPO_ROOT/.env (gitignored). Xcode Cloud
# injects the same names via App Store Connect → Workflow → Environment, so
# we do not source .env there.
if [ -z "${CI_PRIMARY_REPOSITORY_PATH:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
    echo "Loading $REPO_ROOT/.env (local run)"
    set -o allexport
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +o allexport
fi

# Debug: list VITE_* names visible to the script (values stripped — only counts).
echo "VITE_* env vars visible to this script (names only):"
printenv | grep -E '^VITE_' | cut -d= -f1 | sed 's/^/  /' || echo "  (none found)"
echo "VITE_* env-var count: $(printenv | grep -cE '^VITE_' || true)"

REQUIRED_VARS="VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_PAYMENT_PROVIDER VITE_STRIPE_PUBLISHABLE_KEY VITE_API_BASE_URL VITE_REVENUECAT_PUBLIC_SDK_KEY"
MISSING=""
for v in $REQUIRED_VARS; do
    val="$(printenv "$v" || true)"
    if [ -z "$val" ]; then
        MISSING="$MISSING $v"
    fi
done

if [ -n "$MISSING" ]; then
    echo ""
    echo "FATAL: required production env vars missing:$MISSING"
    echo ""
    echo "Vite inlines VITE_* vars into the bundle at build time. Without these"
    echo "the iOS app starts and throws"
    echo "  '[FixUp] Production build requires a Supabase data source.'"
    echo ""
    echo "Set them in:"
    echo "  - Xcode Cloud: App Store Connect → Xcode Cloud → Workflow → Environment"
    echo "  - Local dev:   cp .env.example .env  &&  fill in real values"
    echo ""
    echo "See .env.example for the full reference."
    exit 1
fi

# Reject in-memory mode for native builds — production must use Supabase.
DATA_SOURCE="$(printenv VITE_DATA_SOURCE || true)"
if [ "$DATA_SOURCE" = "in-memory" ]; then
    echo "FATAL: VITE_DATA_SOURCE=in-memory rejected for native builds."
    echo "Production native bundles must use Supabase. Either unset"
    echo "VITE_DATA_SOURCE (auto-detects from URL+ANON_KEY) or set it to 'supabase'."
    exit 1
fi

# Reject service-role-style keys in any VITE_* env var. Service-role keys must
# never ship in the client bundle.
if printenv | grep -E '^VITE_.*SERVICE_ROLE' > /dev/null 2>&1; then
    echo "FATAL: VITE_*SERVICE_ROLE* env var detected. Service-role keys must"
    echo "never be prefixed VITE_ — they would be inlined into the client bundle."
    echo "Use SUPABASE_SERVICE_ROLE_KEY (server-side only, no VITE_ prefix)."
    exit 1
fi

# Payment provider must be 'stripe' for production.
PAYMENT_PROVIDER="$(printenv VITE_PAYMENT_PROVIDER)"
if [ "$PAYMENT_PROVIDER" != "stripe" ]; then
    echo "FATAL: VITE_PAYMENT_PROVIDER='$PAYMENT_PROVIDER' rejected."
    echo "Production builds must use Stripe (mock provider is dev-only)."
    exit 1
fi

# An App Store build must carry Stripe's live publishable key. Accepting
# pk_test_* here produces an apparently functional app that talks to test mode.
PUBLISHABLE_KEY="$(printenv VITE_STRIPE_PUBLISHABLE_KEY)"
case "$PUBLISHABLE_KEY" in
    pk_live_*) ;;
    pk_test_*)
        echo "FATAL: VITE_STRIPE_PUBLISHABLE_KEY is a Stripe test key."
        echo "App Store builds require a pk_live_* publishable key."
        exit 1
        ;;
    sk_*|rk_*)
        echo "FATAL: VITE_STRIPE_PUBLISHABLE_KEY appears to be a secret key."
        echo "Use a pk_live_* publishable key. Secret keys must never"
        echo "ship in the client bundle."
        exit 1
        ;;
    *)
        echo "FATAL: VITE_STRIPE_PUBLISHABLE_KEY must start with pk_live_."
        echo "App Store builds must never ship a test or malformed Stripe key."
        exit 1
        ;;
esac

# API base URL must be an origin, not an /api path: the client appends /api/…
# itself, so a value ending in /api produces /api/api/* → 404 on every call.
API_BASE_URL="$(printenv VITE_API_BASE_URL)"
case "$API_BASE_URL" in
    */api|*/api/)
        echo "FATAL: VITE_API_BASE_URL ('$API_BASE_URL') must not end in /api."
        echo "The client appends /api/… itself — use the bare origin,"
        echo "e.g. https://app.safix.digital"
        exit 1
        ;;
esac

# RevenueCat iOS Public SDK Key must start with appl_. An Android key (goog_)
# or the RC Secret API Key causes HTTP 401 on every RC SDK request.
RC_KEY="$(printenv VITE_REVENUECAT_PUBLIC_SDK_KEY)"
case "$RC_KEY" in
    appl_*) ;;
    goog_*)
        echo "FATAL: VITE_REVENUECAT_PUBLIC_SDK_KEY starts with 'goog_' — Android key used for iOS build."
        echo "iOS requires the Apple Public SDK Key (starts with appl_)."
        echo "Find it: RevenueCat Dashboard → Projects → Apps → <Apple app> → Public SDK Key."
        exit 1
        ;;
    *)
        echo "FATAL: VITE_REVENUECAT_PUBLIC_SDK_KEY does not start with appl_."
        echo "Use the RevenueCat Apple Public SDK Key (starts with appl_)."
        echo "Do NOT use the RevenueCat Secret API Key."
        exit 1
        ;;
esac

# Print only names + char counts — never values. Logs are CI-visible.
echo "Required VITE_* env vars present:"
for v in $REQUIRED_VARS; do
    val="$(printenv "$v")"
    echo "  $v: present (${#val} chars)"
done

# ── build SPA bundle ──────────────────────────────────────────────────────────
echo "=== npm run build ==="
if ! npm run build; then
    echo "FATAL: npm run build failed. SPA bundle not produced. Aborting."
    exit 1
fi

if [ ! -f "dist/index.html" ]; then
    echo "FATAL: dist/index.html missing after npm run build. Build silently produced no bundle. Aborting."
    exit 1
fi
echo "dist/index.html present ($(wc -c < dist/index.html) bytes)"

# ── verify env values were actually INLINED into the bundle ───────────────────
# Defense-in-depth. The pre-build checks above prove the VITE_* vars exist in the
# shell ENV — but that does NOT prove Vite inlined them into the shipped bundle.
# An env-precedence trap can leave a var UNINLINED while it looks "present":
# `vite build` runs in mode=production and loads .env.production (e.g. a
# `vercel env pull` dump whose VITE_* publishables are empty "") AFTER .env.local,
# so an empty file value silently overrides the real one. process.env should win
# on Xcode Cloud, but a committed/synced .env.production* in the clone, an
# envPrefix change, or a typo would still ship an app that boots straight to
# "SDK-Konfigurationsfehler" (RevenueCat) or "requires a Supabase data source".
# Assert each publishable value is PHYSICALLY in dist/ before shipping. The
# values themselves are never printed (CI logs are visible).
echo "=== verify env values inlined into dist bundle ==="
INLINE_VARS="VITE_REVENUECAT_PUBLIC_SDK_KEY VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_STRIPE_PUBLISHABLE_KEY VITE_API_BASE_URL"
NOT_INLINED=""
for v in $INLINE_VARS; do
    val="$(printenv "$v" || true)"
    if [ -z "$val" ]; then
        NOT_INLINED="$NOT_INLINED $v(empty-env)"
        continue
    fi
    if grep -rqF -- "$val" dist/ 2>/dev/null; then
        echo "  $v: inlined ✓"
    else
        NOT_INLINED="$NOT_INLINED $v"
    fi
done

if [ -n "$NOT_INLINED" ]; then
    echo ""
    echo "FATAL: env var(s) present in CI env but NOT inlined into dist/:$NOT_INLINED"
    echo ""
    echo "The value reached the shell but not the bundle — almost always an env"
    echo "precedence trap: a .env.production (vercel-pull dump with empty VITE_*)"
    echo "loaded after .env.local in mode=production. process.env should win on"
    echo "Xcode Cloud — if this fires, check for a committed/synced .env.production*"
    echo "in the clone or a vite.config envPrefix issue. Shipping now would boot the"
    echo "app to 'SDK-Konfigurationsfehler' / no Supabase data source."
    exit 1
fi
echo "All publishable VITE_* values verified present in dist/."

# ── cap copy ios ──────────────────────────────────────────────────────────────
# Web-asset sync only. iOS native deps are SPM (see CapApp-SPM/Package.swift),
# already wired to node_modules paths via npm ci, so no `cap sync ios` needed.
echo "=== npm exec -- cap copy ios ==="
if ! npm exec -- cap copy ios; then
    echo "FATAL: cap copy ios failed. Web bundle did not sync into iOS target. Aborting."
    exit 1
fi

if [ ! -f "ios/App/App/public/index.html" ]; then
    echo "FATAL: ios/App/App/public/index.html missing after cap copy ios. Aborting."
    exit 1
fi
echo "ios/App/App/public/index.html present ($(wc -c < ios/App/App/public/index.html) bytes)"

echo "=== post-clone done ==="
