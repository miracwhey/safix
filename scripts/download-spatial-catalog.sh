#!/usr/bin/env bash
#
# Spatial V1 · Catalog binary-asset downloader
#
# Fetches the CC0 binaries the catalog references — driven entirely by
# public/spatial-assets/asset-manifest.json (generated from the TS catalog
# via scripts/generate-spatial-asset-manifest.ts).
#
#   - 31 ambientCG PBR material sets (1K JPG) + flat albedo previews
#   - 8 Polyhaven HDRIs (2K + 1K EXR) + panorama thumbnails
#   - 14 poly.pizza CC0 GLBs (5 fixtures + 9 furniture) → raw download to
#     models/_raw/, then re-pivoted + re-scaled by repivot-spatial-glb.ts
#   - 1 Polyhaven furniture GLB (mirror) → MANUAL (visual sighting)
#   - 21 procedural placeholder assets → no download (built in L1)
#
# After download:
#   npx tsx scripts/repivot-spatial-glb.ts                       # _raw → models/
#   npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets
#
# Idempotent: existing files are skipped. Requires: curl, unzip, node, xxd.
#
# Usage:  bash scripts/download-spatial-catalog.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="${ROOT}/public/spatial-assets/asset-manifest.json"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "✗ manifest missing — run: npx tsx scripts/generate-spatial-asset-manifest.ts" >&2
  exit 1
fi

echo "→ Materials (ambientCG · CC0)"
node -e '
  const m = require(process.argv[1]);
  for (const x of m.materials)
    console.log([x.acgId, x.pbrZipUrl, x.albedoPreviewUrl, x.stagingDir, x.thumbnailTarget].join("\t"));
' "${MANIFEST}" | while IFS=$'\t' read -r acg zipUrl previewUrl staging thumb; do
  stageDir="${ROOT}/${staging}"
  thumbPath="${ROOT}/${thumb}"
  if [[ -d "${stageDir}" && -n "$(ls -A "${stageDir}" 2>/dev/null)" ]]; then
    echo "  · ${acg} — staged, skip"
  else
    mkdir -p "${stageDir}"
    tmp="${stageDir}/_${acg}.zip"
    if curl -fsSL -o "${tmp}" "${zipUrl}"; then
      unzip -oq "${tmp}" -d "${stageDir}" && rm -f "${tmp}"
      echo "  ✓ ${acg}"
    else
      echo "  ✗ ${acg} — PBR zip download failed" >&2
      rm -f "${tmp}"
    fi
  fi
  if [[ ! -f "${thumbPath}" ]]; then
    mkdir -p "$(dirname "${thumbPath}")"
    curl -fsSL -o "${thumbPath}" "${previewUrl}" \
      && echo "    thumb ✓" || echo "    thumb ✗ ${acg}" >&2
  fi
done

echo "→ HDRIs (Polyhaven · CC0)"
node -e '
  const m = require(process.argv[1]);
  for (const x of m.hdris)
    console.log([x.polyhavenSlug, x.exr2kUrl, x.exr1kUrl, x.panoramaThumbUrl,
                 x.exr2kTarget, x.exr1kTarget, x.thumbnailTarget].join("\t"));
' "${MANIFEST}" | while IFS=$'\t' read -r slug url2k url1k thumbUrl t2k t1k tThumb; do
  for pair in "${url2k}|${t2k}" "${url1k}|${t1k}" "${thumbUrl}|${tThumb}"; do
    src="${pair%%|*}"
    dst="${ROOT}/${pair##*|}"
    if [[ -f "${dst}" ]]; then continue; fi
    mkdir -p "$(dirname "${dst}")"
    curl -fsSL -o "${dst}" "${src}" \
      && echo "  ✓ ${dst##*/}" || echo "  ✗ ${slug} (${src})" >&2
  done
done

echo "→ poly.pizza models (CC0 · direct CDN, no login)"
node -e '
  const m = require(process.argv[1]);
  for (const x of (m.polyPizzaModels || []))
    console.log([x.slug, x.glbUrl, x.rawTarget, x.license].join("\t"));
' "${MANIFEST}" | while IFS=$'\t' read -r slug url target license; do
  dst="${ROOT}/${target}"
  if [[ -f "${dst}" ]]; then
    echo "  · ${slug} — raw exists, skip"
    continue
  fi
  mkdir -p "$(dirname "${dst}")"
  tmp="${dst}.tmp"
  if curl -fsSL -o "${tmp}" "${url}"; then
    # GLB magic-byte check: first 4 bytes must be 0x67 0x6C 0x54 0x46 ("glTF").
    magic=$(head -c 4 "${tmp}" | xxd -p)
    if [[ "${magic}" == "676c5446" ]]; then
      mv "${tmp}" "${dst}"
      echo "  ✓ ${slug} (${license})"
    else
      echo "  ✗ ${slug} — not a GLB (magic=${magic})" >&2
      rm -f "${tmp}"
    fi
  else
    echo "  ✗ ${slug} — download failed" >&2
    rm -f "${tmp}"
  fi
done

echo "→ Other furniture models (Polyhaven · CC0 · MANUAL visual sighting)"
node -e '
  const m = require(process.argv[1]);
  for (const x of (m.models || [])) console.log("  • " + x.slug + " → " + x.target);
  if ((m.models || []).length) console.log("  API: " + m.urlPatterns.polyhavenModelsApi);
' "${MANIFEST}"

echo ""
echo "✓ deterministic assets done. Next:"
echo "  1. re-pivot the raw poly.pizza GLBs: npx tsx scripts/repivot-spatial-glb.ts"
echo "  2. download any MANUAL Polyhaven GLBs listed above"
echo "  3. npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets"
