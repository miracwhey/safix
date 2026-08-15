#!/usr/bin/env bash
#
# Spatial V1 · Phase 0.5 · Asset Download Helper
#
# Pulls the CC0 assets manifest'd in public/spatial-assets/LICENSES.md from
# Polyhaven (HDRIs + models) and ambientCG (PBR materials). Sketchfab CC0
# assets still require manual download because of the per-asset login wall
# — those URLs are commented out below for reference.
#
# All sources verified CC0. Re-check LICENSES.md columns marked TBD after
# downloading; the source pages are authoritative.
#
# Usage:
#   bash scripts/download-spatial-assets.sh
#
# After download, optimise + manifest:
#   npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets
#
# Requires: curl, unzip.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${ROOT}/public/spatial-assets"
BATH="${ASSETS}/poc-bath"
MATS="${ASSETS}/poc-materials"
HDRI="${ASSETS}/poc-hdri"

mkdir -p "${BATH}" "${MATS}" "${HDRI}"

# ── HDRIs (Polyhaven · CC0) ──────────────────────────────────────────────
# Polyhaven file URL pattern:
#   https://dl.polyhaven.org/file/ph-assets/HDRIs/{format}/{res}/{slug}.{ext}

echo "→ Polyhaven HDRIs"
curl -fL --create-dirs -o "${HDRI}/bathroom_4k.exr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/4k/bathroom_4k.exr"
curl -fL --create-dirs -o "${HDRI}/bathroom_2k.exr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/2k/bathroom_2k.exr"
curl -fL --create-dirs -o "${HDRI}/en_suite_2k.exr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/2k/en_suite_2k.exr"
curl -fL --create-dirs -o "${HDRI}/studio_small_03_2k.exr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/2k/studio_small_03_2k.exr"

# ── PBR Materials (ambientCG · CC0) ──────────────────────────────────────
# ambientCG file URL pattern:
#   https://ambientcg.com/get?file={id}_2K-JPG.zip
# We use 2K JPG sets (smaller, fine for POC) — KTX2 conversion happens in
# optimize-spatial-assets.ts. Re-run with 1K-JPG suffix to also stage the
# mobile fallback set.

echo "→ ambientCG PBR materials"
download_mat() {
  local id="$1"
  local res="${2:-2K-JPG}"
  local out="${MATS}/${id}-${res}.zip"
  curl -fL --create-dirs -o "${out}" \
    "https://ambientcg.com/get?file=${id}_${res}.zip"
  mkdir -p "${MATS}/${id}"
  unzip -oq "${out}" -d "${MATS}/${id}"
  rm "${out}"
}

download_mat "Tiles027"
download_mat "Tiles074"
download_mat "Plaster001"
download_mat "Concrete047A"
download_mat "WoodFloor007"

# ── Polyhaven Models (CC0) ───────────────────────────────────────────────
# Polyhaven models live at:
#   https://dl.polyhaven.org/file/ph-assets/Models/gltf/{res}/{slug}/{slug}_{res}.gltf
# (gltf + companion .bin + textures). We grab the .glb single-file form
# where available; the optimize script then re-encodes them.

echo "→ Polyhaven models"
# Toilet: https://polyhaven.com/a/toilet_01
curl -fL --create-dirs -o "${BATH}/toilet_01_2k.glb" \
  "https://dl.polyhaven.org/file/ph-assets/Models/glb/2k/toilet_01/toilet_01_2k.glb"

# NOTE — bathtub / sink / sink-pedestal / towel-rail / mirror / door /
# window-frame: Polyhaven does not currently host these under matching
# slugs. The Sketchfab links from LICENSES.md require a logged-in browser
# session to download (per-asset zip). Manual steps:
#   1. Open each Sketchfab URL in browser, log in, click Download → glTF.
#   2. Extract to public/spatial-assets/poc-bath/.
#   3. Rename to match LICENSES.md row.
#
# Reference URLs (user-side action):
#   - bathtub:        https://sketchfab.com/search?q=bathtub+cc0&type=models
#   - sink:           https://sketchfab.com/search?q=sink+cc0&type=models
#   - sink-pedestal:  https://sketchfab.com/3d-models/{plaggy-collection}
#   - towel-rail:     https://sketchfab.com/3d-models/{Olst-collection}
#   - mirror:         https://sketchfab.com/3d-models/{Olst-collection}
#   - door:           https://sketchfab.com/3d-models/{plaggy-collection}
#   - window-frame:   https://sketchfab.com/3d-models/{plaggy-collection}

echo ""
echo "Done. Verify LICENSES.md, then run:"
echo "  npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets"
