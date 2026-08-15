#!/usr/bin/env bash
# check-plugin-privacy.sh
# Validates that every Capacitor plugin used by FixUp ships a PrivacyInfo.xcprivacy
# at its expected ios Sources path, and that each manifest is valid plist XML.
# Required since iOS 17 (Apple privacy manifest enforcement).
#
# Usage: bash scripts/check-plugin-privacy.sh
# Exit 0 on success, 1 if any plugin is missing a manifest or fails plutil-lint.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NM="${REPO_ROOT}/node_modules"

# Each entry: "<pkg>|<relative-path-to-PrivacyInfo.xcprivacy>"
PLUGINS=(
  "@capacitor/camera|ios/Sources/CameraPlugin/PrivacyInfo.xcprivacy"
  "@capacitor/filesystem|ios/Sources/FilesystemPlugin/PrivacyInfo.xcprivacy"
  "@capacitor/local-notifications|ios/Sources/LocalNotificationsPlugin/PrivacyInfo.xcprivacy"
  "@capacitor/push-notifications|ios/Sources/PushNotificationsPlugin/PrivacyInfo.xcprivacy"
  "@independo/capacitor-voice-recorder|ios/Sources/VoiceRecorder/PrivacyInfo.xcprivacy"
  "@revenuecat/purchases-capacitor|ios/Sources/RevenuecatPurchasesCapacitor/PrivacyInfo.xcprivacy"
)

# In-repo plugin (capacitor-roomplan) — checked separately, not under node_modules.
INREPO_PLUGINS=(
  "packages/capacitor-roomplan|ios/Sources/RoomPlan/PrivacyInfo.xcprivacy"
)

errors=0

check_manifest() {
  local label="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    echo "MISSING: $label  ->  $file"
    errors=$((errors + 1))
    return
  fi

  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$file" >/dev/null; then
      echo "INVALID PLIST: $label  ->  $file"
      errors=$((errors + 1))
      return
    fi
  fi

  echo "OK: $label"
}

# node_modules plugins (must exist — patch-package applies via postinstall).
for entry in "${PLUGINS[@]}"; do
  pkg="${entry%%|*}"
  rel="${entry#*|}"
  pkg_root="${NM}/${pkg}"

  if [[ ! -d "$pkg_root" ]]; then
    # Package not installed (e.g. before `npm install`). Skip with warning,
    # do not fail — CI runs after install so this branch is informational.
    echo "SKIP (not installed): $pkg"
    continue
  fi

  check_manifest "$pkg" "${pkg_root}/${rel}"
done

# In-repo plugin (capacitor-roomplan).
for entry in "${INREPO_PLUGINS[@]}"; do
  pkg="${entry%%|*}"
  rel="${entry#*|}"
  check_manifest "$pkg" "${REPO_ROOT}/${pkg}/${rel}"
done

# Also validate the app-level manifest.
check_manifest "ios/App (app-level)" "${REPO_ROOT}/ios/App/App/PrivacyInfo.xcprivacy"

if [[ "$errors" -gt 0 ]]; then
  echo
  echo "check-plugin-privacy FAILED ($errors issue(s))"
  exit 1
fi

echo
echo "check-plugin-privacy OK"
