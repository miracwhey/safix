#!/usr/bin/env bash
# V1.5 Hotfix R3-P3 — mesh-quality validator.
#
# Runs between postprocess.sh and the upload step in convertJob.js to fail
# fast on conversions that would surface broken/oversized models in the
# viewer. Three gates, ordered cheapest-first:
#
#   1. Spec compliance (gltf-transform validate) — Khronos validator reports
#      any spec error → fail. These are the bugs that would silently break
#      three.js / model-viewer at load-time.
#   2. Vertex-count sanity — < 8 vertices means the cleanup stage collapsed
#      the room into a single face (degenerate output, no usable geometry).
#   3. Size guardrail — > 25 MB is well beyond what a Meshopt + KTX2 single-
#      room scan should ever produce. Catches a runaway texture-encode
#      escape early before the upload pays bandwidth.
#
# Args: $1 = optimized.glb
#
# Exit codes:
#   0  — all checks passed
#   1  — validation failed (with reason on stderr)
set -euo pipefail

GLB="${1:-}"
if [[ -z "$GLB" || ! -f "$GLB" ]]; then
  echo "validate-mesh: input file missing: $GLB" >&2
  exit 1
fi

# 1. Spec-validation via gltf-transform's Khronos-validator wrapper.
#    --format json emits a machine-readable report we parse with jq.
gltf-transform validate "$GLB" --format json > /tmp/validation.json

# `issues.numErrors` is the headline counter; messages with severity=0 are
# errors (per the Khronos validator spec). Either signal triggers a fail.
ERROR_COUNT=$(jq -r '.issues.numErrors // 0' /tmp/validation.json)
if [[ "$ERROR_COUNT" != "0" ]]; then
  echo "validate-mesh: FAIL — $ERROR_COUNT spec error(s)" >&2
  jq '.issues.messages[] | select(.severity == 0)' /tmp/validation.json >&2
  exit 1
fi

# 2. Stats sanity. `inspect --format json` returns per-mesh vertex counts.
STATS=$(gltf-transform inspect "$GLB" --format json)
VERTICES=$(echo "$STATS" | jq '[.scenes[0].meshes[].vertexCount // 0] | add // 0')
if [[ "$VERTICES" -lt 8 ]]; then
  echo "validate-mesh: FAIL — only $VERTICES vertices (degenerate output)" >&2
  exit 1
fi

# 3. Size guardrail. BSD `stat -f` (macOS dev) vs GNU `stat -c` (Linux/CR).
SIZE_BYTES=$(stat -c%s "$GLB" 2>/dev/null || stat -f%z "$GLB")
MAX_BYTES=$((25 * 1024 * 1024))
if [[ "$SIZE_BYTES" -gt "$MAX_BYTES" ]]; then
  echo "validate-mesh: FAIL — $SIZE_BYTES bytes exceeds $MAX_BYTES" >&2
  exit 1
fi

echo "validate-mesh: OK — $VERTICES vertices, $SIZE_BYTES bytes" >&2
exit 0
