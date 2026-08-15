# Spatial V1 · CC0 / Liberal Asset Licenses

Tracking every third-party asset shipped under `public/spatial-assets/`.
Each row records the source, license, attribution requirement, and the
local file. KEEP THIS FILE UP TO DATE — Sketchfab in particular has
hundreds of CC0 collections whose source URLs are easy to lose.

## Provenance rules

1. **Only CC0, CC-BY 4.0, or LGPL-compatible licenses are eligible.**
2. Any CC-BY 4.0 asset MUST surface attribution in the in-app credits
   screen (Day 17 wires this via `LICENSES.json` consumed by the
   credits screen).
3. Anything ambiguous (e.g. "free for personal use") is REJECTED.
4. Provider profile / model uuid / scrape date go in the `Source` cell
   so we can re-verify the license years later.

## POC bath-room (Day 13)

### Furniture / fixtures (8 assets · Polyhaven + Sketchfab CC0)

Status legend: ✅ downloaded · ⏳ user-side download needed (login wall).

| File | Status | License | Source | Notes |
|---|---|---|---|---|
| poc-bath/toilet.glb         | ⏳ | CC0 | https://polyhaven.com/a/toilet_01 | Polyhaven URL pattern changed; need manual download |
| poc-bath/bathtub.glb        | ⏳ | CC0 | sketchfab search "bathtub cc0" | login wall |
| poc-bath/sink.glb           | ⏳ | CC0 | sketchfab search "sink cc0" | login wall |
| poc-bath/sink-pedestal.glb  | ⏳ | CC0 | Sketchfab `plaggy` collection | login wall |
| poc-bath/towel-rail.glb     | ⏳ | CC0 | Sketchfab `Olst` collection | login wall |
| poc-bath/mirror.glb         | ⏳ | CC0 | Sketchfab `Olst` collection | login wall |
| poc-bath/door.glb           | ⏳ | CC0 | Sketchfab `plaggy` collection | login wall |
| poc-bath/window-frame.glb   | ⏳ | CC0 | Sketchfab `plaggy` collection | login wall |

### PBR Materials (5 sets · ambientCG)

| File | Status | License | Source | Notes |
|---|---|---|---|---|
| poc-materials/Tiles027/      | ✅ | CC0 | https://ambientcg.com/view?id=Tiles027      | 2K JPG (Color · NormalDX · NormalGL · Roughness · AO · Displacement) |
| poc-materials/Tiles074/      | ✅ | CC0 | https://ambientcg.com/view?id=Tiles074      | 2K JPG (Color · NormalDX · NormalGL · Roughness · Displacement) |
| poc-materials/Plaster001/    | ✅ | CC0 | https://ambientcg.com/view?id=Plaster001    | wall material · 2K JPG |
| poc-materials/Concrete047A/  | ✅ | CC0 | https://ambientcg.com/view?id=Concrete047A  | floor entry zone · 2K JPG |
| poc-materials/WoodFloor007/  | ✅ | CC0 | https://ambientcg.com/view?id=WoodFloor007  | wood floor · 2K JPG |

### HDRIs (4 environments · Polyhaven)

| File | Status | License | Source | Notes |
|---|---|---|---|---|
| poc-hdri/bathroom_4k.exr        | ✅ | CC0 | https://polyhaven.com/a/bathroom_4k       | 4K bath HDRI · 19.9 MB |
| poc-hdri/bathroom_2k.exr        | ✅ | CC0 | same source, 2K downscale                  | mobile fallback · 5.0 MB |
| poc-hdri/en_suite_2k.exr        | ✅ | CC0 | https://polyhaven.com/a/en_suite           | alt bath HDRI · 4.9 MB |
| poc-hdri/studio_small_03_2k.exr | ✅ | CC0 | https://polyhaven.com/a/studio_small_03    | neutral studio fallback · 5.5 MB |

## Spatial V1 catalog models (B-6 · poly.pizza CC0)

The catalog GLB upgrade (`scripts/repivot-spatial-glb.ts`). All Quaternius /
Kenney models — verified CC0-1.0 re-uploads of the official `Ultimate House
Interior Pack` / `Furniture Kit` packs. **No attribution required (CC0).**
Raw GLBs downloaded to `models/_raw/`, then re-pivoted + re-scaled to the
catalog dimensions; the final binaries land in `models/{slug}.glb`.

Scrape date: 2026-05-21 · magic-byte `676c5446` verified on every file.

### Fixtures (5 · procedural → GLB)

| File | License | Source | Creator |
|---|---|---|---|
| models/sanitary-toilet-standard-floor.glb         | CC0-1.0 | https://poly.pizza/m/WAu50yGFVt | Quaternius |
| models/sanitary-sink-pedestal-classic.glb         | CC0-1.0 | https://poly.pizza/m/iUz9JXhDE1 | Kenney |
| models/sanitary-bathtub-builtin-rectangle.glb     | CC0-1.0 | https://poly.pizza/m/kVFRyNEn4F | Kenney |
| models/kitchen-refrigerator-freestanding-tall.glb | CC0-1.0 | https://poly.pizza/m/8sjRm8fnHh | Quaternius |
| models/kitchen-microwave-countertop.glb           | CC0-1.0 | https://poly.pizza/m/vUsvf2HGDv | Kenney |

### Furniture (9 · Polyhaven PBR → poly.pizza low-poly)

| File | License | Source | Creator |
|---|---|---|---|
| models/furn-sofa-3seater-fabric-grey.glb   | CC0-1.0 | https://poly.pizza/m/6MoOyPtetL | Quaternius |
| models/furn-armchair-fabric-rounded.glb    | CC0-1.0 | https://poly.pizza/m/ZOPP3KzNIk | Quaternius |
| models/furn-coffee-table-round-wood.glb    | CC0-1.0 | https://poly.pizza/m/57W671WvS2 | Quaternius |
| models/furn-dining-table-rectangle-6.glb   | CC0-1.0 | https://poly.pizza/m/yYEEJzKxb4 | Quaternius |
| models/furn-dining-chair-wood-fabric.glb   | CC0-1.0 | https://poly.pizza/m/iMNqRzPwwe | Quaternius |
| models/furn-bed-double-frame-headboard.glb | CC0-1.0 | https://poly.pizza/m/BuRay4fVFr | Quaternius |
| models/furn-wardrobe-3door-tall.glb        | CC0-1.0 | https://poly.pizza/m/BHEVb1DIuH | Quaternius |
| models/furn-shelf-open-5tier-wood.glb      | CC0-1.0 | https://poly.pizza/m/MTH8ZwnA27 | Kenney |
| models/furn-floor-lamp-tripod.glb          | CC0-1.0 | https://poly.pizza/m/8LiDIfXVLi | Kenney |

`furn-mirror-round-wall.glb` keeps its Polyhaven CC0 model — no round
wall-mirror exists on poly.pizza (only CC-BY candidates).

## Repo storage

The binary asset files are **gitignored** (~150 MB unpacked) so the
repo stays small. Each leaf folder has a `.gitkeep` marker so the
directory structure is checked in.

## Download manifest (user-side)

Helper script auto-fetches Polyhaven HDRIs + ambientCG PBR materials
(direct CC0 download URLs, no login required):

```bash
bash scripts/download-spatial-assets.sh
```

Sketchfab CC0 furniture models require a Sketchfab login per asset —
open each URL in a browser, click Download → glTF, drop into
`public/spatial-assets/poc-bath/`.

After both steps, optimise + re-manifest:

```bash
npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets
```

The optimiser:
- Re-encodes glb files with Meshopt + KTX2 textures (gltf-transform).
- Generates 2K and 1K material sets per ambientCG source (the 1K is
  the `useDetectGPU` mobile fallback).
- Verifies every file is < 5 MB pre-gzip; warns when over.
- Writes a `manifest.json` per-folder so the renderer can discover the
  set without filename guessing.

Replace `TBD` in the License column with the actual license string
once each file has been verified and dropped in place.

## V1.6.1 · L0 Customer-Hub wall fixtures (poly.pizza · CC-BY 3.0)

No scriptable CC0 source exists for a wall panel radiator, a Schuko/EU
socket, or a flush wall light switch (Quaternius/Kenney game packs don't
model these; Polyhaven is weak on fixtures; Sketchfab CC0 is login-walled).
These three ship under **CC-BY 3.0** — attribution is MANDATORY and MUST be
surfaced in the in-app credits screen (per provenance rule 2). The catalog
carries `license: 'CC-BY-3.0'` + `attribution` for each.

| File | License | Source | Attribution |
|---|---|---|---|
| models/arch-radiator-panel-typ22.glb | CC-BY 3.0 | https://poly.pizza/m/4XJ-DH66eKY | Radiator – Poly by Google |
| models/arch-outlet-schuko-de.glb     | CC-BY 3.0 | https://poly.pizza/m/MCMUq7R1w5  | EU Outlet – J-Toastie |
| models/arch-switch-rocker-55.glb     | CC-BY 3.0 | https://poly.pizza/m/8sR1PkyAg-F | Light switch – Poly by Google |
