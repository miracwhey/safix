#!/usr/bin/env bash
# Convert USDZ → glb (Blender) → optimized glb (gltf-transform Meshopt + KTX2).
#
# Args: $1 = input.usdz  $2 = raw.glb  $3 = output.glb
#
# Decision D15: Meshopt + KTX2 (~60-80% size reduction vs raw glb).
# DRACO would conflict with Meshopt (glb only holds one geometry compression),
# and Meshopt's decoder is smaller and faster on mobile WebGL/WebGPU.
#
# V1.5 Hotfix R3-P2 tuning vs pre-hotfix:
#   --simplify-error 0.01      (was 0.0001 = 100× stricter than the gltf-
#                               transform default, which effectively disabled
#                               simplify; raised to the sensible 1% quality
#                               budget per Khronos asset-creation guidelines)
#   --simplify-ratio 0.85      (cap max vertex reduction; works as a safety
#                               brake when --simplify-error widens — keeps
#                               wall corners from collapsing on aggressive
#                               error budgets)
#   --simplify-lock-border     (prevents seam-tearing on UV/material borders;
#                               was default-true in gltf-transform 4.3+ but
#                               our v3 image needs it explicit)
#   --weld true                (was default-true; explicit for audit-trail)
#
# convert.py adds a per-mesh Blender cleanup stage upstream (R3-P1) so the
# gltf-transform weld sees clean topology; the two patches are paired.
set -euo pipefail

INPUT_USDZ="$1"
RAW_GLB="$2"
OUT_GLB="$3"

# Blender import + cleanup + export. `--no-window-focus` + `--background`
# keep the headless container quiet; logs flow to stdout for Cloud Run
# capture. V1.5 Hotfix R3-P1: convert.py runs a per-mesh cleanup
# (customdata-clear → remove_doubles → normals-consistent → auto-smooth)
# between import and export to fix the "fransige Ränder" from USD-import
# float-drift.
blender \
  --background \
  --no-window-focus \
  --python /app/scripts/convert.py \
  -- "$INPUT_USDZ" "$RAW_GLB"

# gltf-transform pipeline:
#   weld        — merge near-identical vertices (bitwise-exact since 4.0)
#   simplify    — meshopt-driven decimation, error- + ratio-bounded
#   dedup       — collapse duplicate accessors / buffers (always-on)
#   prune       — drop unused nodes / materials (always-on)
#   resample    — discard redundant animation samples (no-op here)
#   meshopt     — Meshopt mesh compression (Meshopt buffer-view extension)
#   uastc       — KTX2 texture compression (universal, decodes on iOS+Android)
gltf-transform optimize "$RAW_GLB" "$OUT_GLB" \
  --weld true \
  --simplify true \
  --simplify-error 0.01 \
  --simplify-ratio 0.85 \
  --simplify-lock-border true \
  --compress meshopt \
  --texture-compress ktx2 \
  --instance true
