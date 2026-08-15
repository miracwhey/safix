/**
 * Spatial · Canonical · Geometry · Procedural Asset Placeholders
 *
 * Phase-1 box-placeholder geometry for the 26 sanitary / kitchen /
 * architecture catalog assets that have no directly-loadable CC0 GLB
 * (asset-source-map §0 binding strategy).
 *
 * Each placeholder is a recognisable primitive composition — a toilet is a
 * bowl box + a tank box, a tub is an open-top box — with a correct bounding
 * box and pivot. That is enough for the provider to read position, size and
 * placement; visual fidelity arrives in Phase 2 when real GLB models swap in
 * behind the SAME slug + pivot, with no schema change.
 *
 * Furniture (10 models) is sourced as real Polyhaven CC0 GLB and is NOT
 * listed here; if such a model fails to load the renderer falls back to
 * {@link buildGenericBox} from the catalog dimensions.
 *
 * Pure L1: no three.js / React / DOM. Consumes only `procedural-primitives`.
 */

import type { Vector3 } from '../types/primitives.ts'
import type { PivotType } from '../types/asset.ts'
import {
  type ProceduralMesh,
  type MeshBounds,
  makeBox,
  makeCylinder,
  makeOpenTopBox,
  mergeMeshes,
  translateMesh,
  computeMeshBounds,
  triangleCount,
} from './procedural-primitives.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Local part helpers — keep each fixture spec terse + readable
// ─────────────────────────────────────────────────────────────────────────────

/** Axis-aligned box, dimensions + center given as scalars. */
const box = (w: number, h: number, d: number, cx: number, cy: number, cz: number): ProceduralMesh =>
  makeBox({ x: w, y: h, z: d }, { x: cx, y: cy, z: cz })

/** Vertical cylinder / cone, center given as scalars. */
const cyl = (
  rTop: number,
  rBottom: number,
  h: number,
  cx: number,
  cy: number,
  cz: number,
  segments = 16,
): ProceduralMesh =>
  makeCylinder({ radiusTop: rTop, radiusBottom: rBottom, height: h, radialSegments: segments }, { x: cx, y: cy, z: cz })

/** Open-top box (basin / tub / shower tray), center given as scalars. */
const tray = (
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  wallThickness: number,
): ProceduralMesh =>
  makeOpenTopBox({ x: w, y: h, z: d }, wallThickness, { x: cx, y: cy, z: cz })

// ─────────────────────────────────────────────────────────────────────────────
// Spec table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A procedural asset spec — the pivot convention plus a builder that returns
 * the merged mesh in a natural asset-local frame (floor assets rest on y=0;
 * wall assets protrude along +Z from the z=0 wall plane). `buildProceduralAsset`
 * re-bases the vertices so the pivot point sits at the origin.
 */
interface ProceduralAssetSpec {
  pivot: PivotType
  build: () => ProceduralMesh
}

/** Result of materialising a procedural asset (pivot point at the origin). */
export interface ProceduralAssetResult {
  slug: string
  mesh: ProceduralMesh
  /** Bounds after pivot normalisation — pivot reference point is at (0,0,0). */
  bbox: MeshBounds
  dimensions: { width_m: number; depth_m: number; height_m: number }
  pivot: PivotType
  triangles: number
}

const SANITARY_SPECS: Record<string, ProceduralAssetSpec> = {
  'sanitary-toilet-standard-floor': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.37, 0.4, 0.5, 0, 0.2, 0.05), // bowl
        box(0.37, 0.05, 0.5, 0, 0.43, 0.05), // seat
        box(0.37, 0.42, 0.18, 0, 0.42, -0.31), // cistern
      ]),
  },
  'sanitary-toilet-wall-hung': {
    pivot: 'wall_back_center',
    build: () =>
      mergeMeshes([
        box(0.37, 0.55, 0.12, 0, 0.45, 0.06), // concealed-cistern panel
        box(0.37, 0.32, 0.5, 0, 0.18, 0.31), // bowl
      ]),
  },
  'sanitary-sink-pedestal-classic': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        tray(0.5, 0.18, 0.42, 0, 0.82, 0, 0.05), // basin
        cyl(0.1, 0.14, 0.73, 0, 0.365, -0.02, 20), // pedestal
      ]),
  },
  'sanitary-sink-vanity-rectangle': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.6, 0.7, 0.45, 0, 0.35, 0), // cabinet
        box(0.64, 0.04, 0.48, 0, 0.72, 0), // countertop
        tray(0.4, 0.14, 0.32, 0, 0.75, 0, 0.04), // basin
      ]),
  },
  'sanitary-sink-double-vanity': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(1.2, 0.7, 0.48, 0, 0.35, 0), // cabinet
        box(1.24, 0.04, 0.5, 0, 0.72, 0), // countertop
        tray(0.42, 0.14, 0.34, -0.28, 0.75, 0, 0.04), // basin L
        tray(0.42, 0.14, 0.34, 0.28, 0.75, 0, 0.04), // basin R
      ]),
  },
  'sanitary-bathtub-freestanding-oval': {
    pivot: 'bottom_center',
    build: () => tray(1.7, 0.58, 0.75, 0, 0.29, 0, 0.07),
  },
  'sanitary-bathtub-builtin-rectangle': {
    pivot: 'bottom_center',
    build: () => tray(1.7, 0.56, 0.75, 0, 0.28, 0, 0.06),
  },
  'sanitary-shower-walkin-corner': {
    pivot: 'corner_back_left',
    build: () =>
      mergeMeshes([
        box(0.9, 0.06, 0.9, 0.45, 0.03, 0.45), // tray
        box(0.9, 2.0, 0.04, 0.45, 1.0, 0.88), // glass panel — front
        box(0.04, 2.0, 0.9, 0.88, 1.0, 0.45), // glass panel — side
      ]),
  },
  'sanitary-shower-enclosure-square': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.9, 0.08, 0.9, 0, 0.04, 0), // tray
        box(0.9, 2.0, 0.04, 0, 1.0, -0.43), // back panel
        box(0.04, 2.0, 0.86, -0.43, 1.0, 0), // left panel
        box(0.04, 2.0, 0.86, 0.43, 1.0, 0), // right panel
      ]),
  },
  'sanitary-bidet-floor-standing': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        tray(0.36, 0.18, 0.5, 0, 0.31, 0, 0.04), // bowl
        box(0.2, 0.22, 0.3, 0, 0.11, -0.05), // base
      ]),
  },
}

const KITCHEN_SPECS: Record<string, ProceduralAssetSpec> = {
  'kitchen-sink-undermount-double': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.9, 0.04, 0.6, 0, 0.84, 0), // countertop slab
        tray(0.34, 0.2, 0.4, -0.2, 0.72, 0, 0.04), // basin L
        tray(0.34, 0.2, 0.4, 0.2, 0.72, 0, 0.04), // basin R
      ]),
  },
  'kitchen-stove-induction-60cm': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.6, 0.05, 0.52, 0, 0.025, 0), // glass plate
        cyl(0.09, 0.09, 0.006, -0.15, 0.053, 0.13, 20), // burner zone
        cyl(0.09, 0.09, 0.006, 0.15, 0.053, 0.13, 20),
        cyl(0.07, 0.07, 0.006, -0.15, 0.053, -0.13, 20),
        cyl(0.07, 0.07, 0.006, 0.15, 0.053, -0.13, 20),
      ]),
  },
  'kitchen-oven-builtin-60cm': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.6, 0.6, 0.56, 0, 0.3, 0), // body
        box(0.56, 0.5, 0.04, 0, 0.32, 0.3), // door
        box(0.5, 0.04, 0.05, 0, 0.56, 0.34), // handle
      ]),
  },
  'kitchen-refrigerator-freestanding-tall': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.7, 1.85, 0.7, 0, 0.925, 0), // body
        box(0.7, 0.02, 0.02, 0, 1.1, 0.36), // fridge/freezer seam
        box(0.05, 0.6, 0.06, 0.3, 1.4, 0.38), // handle — upper
        box(0.05, 0.4, 0.06, 0.3, 0.5, 0.38), // handle — lower
      ]),
  },
  'kitchen-dishwasher-builtin-60cm': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.6, 0.82, 0.57, 0, 0.41, 0), // body
        box(0.58, 0.78, 0.04, 0, 0.41, 0.3), // front panel
        box(0.5, 0.04, 0.05, 0, 0.78, 0.33), // handle
      ]),
  },
  'kitchen-extractor-hood-wall-mounted': {
    pivot: 'wall_back_center',
    build: () =>
      mergeMeshes([
        box(0.6, 0.18, 0.48, 0, 0.09, 0.26), // canopy
        box(0.22, 0.5, 0.18, 0, 0.43, 0.1), // chimney
      ]),
  },
  'kitchen-microwave-countertop': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.5, 0.3, 0.38, 0, 0.15, 0), // body
        box(0.34, 0.26, 0.03, -0.06, 0.15, 0.2), // door
        box(0.12, 0.26, 0.02, 0.19, 0.15, 0.2), // control panel
      ]),
  },
  'kitchen-faucet-pullout-tall': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        cyl(0.03, 0.04, 0.05, 0, 0.025, 0, 16), // base
        cyl(0.022, 0.022, 0.32, 0, 0.21, 0, 12), // stem
        box(0.04, 0.04, 0.16, 0, 0.385, 0.07), // gooseneck
        cyl(0.018, 0.018, 0.07, 0, 0.335, 0.13, 12), // pull-out spout
      ]),
  },
}

const ARCHITECTURE_SPECS: Record<string, ProceduralAssetSpec> = {
  'arch-door-single-leaf-standard': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.06, 2.1, 0.12, -0.45, 1.05, 0), // jamb L
        box(0.06, 2.1, 0.12, 0.45, 1.05, 0), // jamb R
        box(0.96, 0.06, 0.12, 0, 2.07, 0), // head
        box(0.82, 2.0, 0.045, 0, 1.0, 0), // leaf
        box(0.03, 0.14, 0.07, 0.32, 1.05, 0.05), // handle
      ]),
  },
  'arch-door-double-french': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.06, 2.1, 0.12, -0.78, 1.05, 0), // jamb L
        box(0.06, 2.1, 0.12, 0.78, 1.05, 0), // jamb R
        box(1.62, 0.06, 0.12, 0, 2.07, 0), // head
        box(0.72, 2.0, 0.045, -0.37, 1.0, 0), // leaf L
        box(0.72, 2.0, 0.045, 0.37, 1.0, 0), // leaf R
        box(0.03, 0.14, 0.07, -0.05, 1.05, 0.05), // handle L
        box(0.03, 0.14, 0.07, 0.05, 1.05, 0.05), // handle R
      ]),
  },
  'arch-window-double-hung-standard': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.07, 1.4, 0.12, -0.565, 0.7, 0), // jamb L
        box(0.07, 1.4, 0.12, 0.565, 0.7, 0), // jamb R
        box(1.2, 0.07, 0.12, 0, 1.365, 0), // head
        box(1.2, 0.07, 0.12, 0, 0.035, 0), // sill
        box(1.06, 0.05, 0.04, 0, 0.7, 0), // meeting rail
        box(1.06, 1.26, 0.02, 0, 0.7, 0), // glazing
      ]),
  },
  'arch-window-casement-2-pane': {
    pivot: 'bottom_center',
    build: () =>
      mergeMeshes([
        box(0.07, 1.4, 0.12, -0.565, 0.7, 0), // jamb L
        box(0.07, 1.4, 0.12, 0.565, 0.7, 0), // jamb R
        box(1.2, 0.07, 0.12, 0, 1.365, 0), // head
        box(1.2, 0.07, 0.12, 0, 0.035, 0), // sill
        box(0.05, 1.26, 0.05, 0, 0.7, 0), // center mullion
        box(0.5, 1.26, 0.02, -0.27, 0.7, 0), // glazing L
        box(0.5, 1.26, 0.02, 0.27, 0.7, 0), // glazing R
      ]),
  },
  'arch-radiator-panel-wall': {
    pivot: 'wall_back_center',
    build: () => {
      const parts: ProceduralMesh[] = [box(0.8, 0.6, 0.04, 0, 0.3, 0.02)]
      const finCount = 9
      for (let i = 0; i < finCount; i++) {
        const x = -0.36 + (i / (finCount - 1)) * 0.72
        parts.push(box(0.045, 0.56, 0.06, x, 0.3, 0.07))
      }
      return mergeMeshes(parts)
    },
  },
  'arch-radiator-towel-bath': {
    pivot: 'wall_back_center',
    build: () => {
      const parts: ProceduralMesh[] = [
        box(0.04, 1.1, 0.06, -0.23, 0.55, 0.04), // side bar L
        box(0.04, 1.1, 0.06, 0.23, 0.55, 0.04), // side bar R
      ]
      const rungCount = 8
      for (let i = 0; i < rungCount; i++) {
        const y = 0.12 + (i / (rungCount - 1)) * 0.86
        parts.push(box(0.5, 0.03, 0.03, 0, y, 0.05)) // towel rung
      }
      return mergeMeshes(parts)
    },
  },
  'arch-outlet-socket-double': {
    pivot: 'wall_back_center',
    build: () =>
      mergeMeshes([
        box(0.16, 0.09, 0.012, 0, 0, 0.006), // faceplate
        cyl(0.026, 0.028, 0.012, -0.035, 0, 0.013, 20), // socket recess L
        cyl(0.026, 0.028, 0.012, 0.035, 0, 0.013, 20), // socket recess R
      ]),
  },
  'arch-light-switch-single': {
    pivot: 'wall_back_center',
    build: () =>
      mergeMeshes([
        box(0.08, 0.08, 0.012, 0, 0, 0.006), // faceplate
        box(0.05, 0.05, 0.012, 0, 0, 0.014), // rocker
      ]),
  },
  // ── Phase 2 · 8 DE-Hero refined procedural-Generators (2026-05-28) ─────────
  // brand-neutral DIN-conform: Plattenheizkörper Typ-22, Bodenkonvektor,
  // Schuko-Steckdose DIN 49441, Wippschalter 55×55 single+double,
  // Sicherungskasten Hager-Style, Abzweigdose, Spiegelschrank mit LED.
  // Refined variants of existing slugs (panel-typ22 vs panel-wall, schuko-de
  // vs socket-double, switch-rocker-55 vs switch-single) — keep old slugs for
  // backward-compat with placed-objects, new slugs deliver DE-Hero fidelity.
  'arch-radiator-panel-typ22': {
    pivot: 'wall_back_center',
    build: () => {
      // DIN Plattenheizkörper Typ-22 · Doppel-Panel + Konvektor-Rippen-Reihe
      const W = 1.0
      const H = 0.6
      const D = 0.07
      const parts: ProceduralMesh[] = [
        box(W, H, 0.012, 0, H / 2, 0.006), // front-panel
        box(W, H, 0.012, 0, H / 2, D - 0.006), // back-panel
        box(W, 0.04, D, 0, H + 0.02, D / 2), // top-cap
        box(W, 0.04, D, 0, -0.02, D / 2), // bottom-cap
        cyl(0.015, 0.015, 0.04, -W / 2 + 0.08, -0.04, D / 2, 12), // supply pipe L
        cyl(0.015, 0.015, 0.04, W / 2 - 0.08, -0.04, D / 2, 12), // supply pipe R
      ]
      // Convector fins between front + back panel
      const finCount = 12
      const finPitch = (W - 0.06) / (finCount - 1)
      for (let i = 0; i < finCount; i++) {
        const x = -W / 2 + 0.03 + i * finPitch
        parts.push(box(0.018, H - 0.04, D - 0.04, x, H / 2, D / 2))
      }
      return mergeMeshes(parts)
    },
  },
  'arch-radiator-convector-floor': {
    pivot: 'bottom_center',
    build: () => {
      // Bodenkonvektor · Box-Gehäuse mit Gitterrost-Top
      const W = 1.0
      const H = 0.08
      const D = 0.25
      const parts: ProceduralMesh[] = [
        // open-top tray as housing
        tray(W, H, D, 0, H / 2, 0, 0.008),
      ]
      // grille-bars across the top (visual stand-in for the rost)
      const barCount = 28
      const barPitch = (W - 0.04) / (barCount - 1)
      for (let i = 0; i < barCount; i++) {
        const x = -W / 2 + 0.02 + i * barPitch
        parts.push(box(0.006, 0.006, D - 0.04, x, H + 0.003, 0))
      }
      return mergeMeshes(parts)
    },
  },
  'arch-outlet-schuko-de': {
    pivot: 'wall_back_center',
    build: () =>
      // DIN 49441 Typ F · Single Schuko · System-55 frame approximation
      mergeMeshes([
        box(0.08, 0.08, 0.012, 0, 0, 0.006), // square faceplate (System-55)
        cyl(0.034, 0.034, 0.005, 0, 0, 0.014, 24), // round recess
        cyl(0.0025, 0.0025, 0.008, -0.012, 0, 0.018, 12), // pin-hole L
        cyl(0.0025, 0.0025, 0.008, 0.012, 0, 0.018, 12), // pin-hole R
        box(0.04, 0.005, 0.004, 0, 0.025, 0.018), // earth-clip top
        box(0.04, 0.005, 0.004, 0, -0.025, 0.018), // earth-clip bottom
      ]),
  },
  'arch-outlet-schuko-de-double': {
    pivot: 'wall_back_center',
    build: () => {
      // Two Schukos side-by-side in a 2-fach frame
      const parts: ProceduralMesh[] = [
        box(0.16, 0.08, 0.012, 0, 0, 0.006), // double-faceplate
      ]
      // Replicate single-schuko geometry at ±0.04 x-offset
      for (const dx of [-0.04, 0.04]) {
        parts.push(
          cyl(0.034, 0.034, 0.005, dx, 0, 0.014, 24),
          cyl(0.0025, 0.0025, 0.008, dx - 0.012, 0, 0.018, 12),
          cyl(0.0025, 0.0025, 0.008, dx + 0.012, 0, 0.018, 12),
          box(0.04, 0.005, 0.004, dx, 0.025, 0.018),
          box(0.04, 0.005, 0.004, dx, -0.025, 0.018),
        )
      }
      return mergeMeshes(parts)
    },
  },
  'arch-switch-rocker-55': {
    pivot: 'wall_back_center',
    build: () =>
      // Wippschalter 55×55 DE-Style · square frame with raised rocker
      mergeMeshes([
        box(0.08, 0.08, 0.012, 0, 0, 0.006), // square faceplate (System-55)
        box(0.05, 0.05, 0.008, 0, 0, 0.016), // rocker pad
        box(0.05, 0.001, 0.001, 0, 0, 0.021), // rocker centerline (visual cue)
      ]),
  },
  'arch-switch-rocker-double': {
    pivot: 'wall_back_center',
    build: () => {
      // Two rockers side-by-side in a 2-fach frame
      const parts: ProceduralMesh[] = [
        box(0.16, 0.08, 0.012, 0, 0, 0.006),
      ]
      for (const dx of [-0.04, 0.04]) {
        parts.push(
          box(0.05, 0.05, 0.008, dx, 0, 0.016),
          box(0.05, 0.001, 0.001, dx, 0, 0.021),
        )
      }
      return mergeMeshes(parts)
    },
  },
  'arch-distribution-box-hager': {
    pivot: 'wall_back_center',
    build: () => {
      // Sicherungskasten brand-neutral · door + Hutschiene + LS-Module
      const W = 0.3
      const H = 0.4
      const D = 0.1
      const parts: ProceduralMesh[] = [
        box(W, H, D, 0, H / 2, D / 2), // outer housing
        box(W - 0.02, H - 0.02, 0.008, 0, H / 2, D - 0.004), // recessed door
      ]
      // LS-Schalter-Module on a Hutschiene (visual cue: 12 small bumps in 2 rows)
      const moduleCount = 12
      for (let row = 0; row < 2; row++) {
        const y = H / 2 - 0.08 + row * 0.1
        for (let i = 0; i < moduleCount; i++) {
          const x = -W / 2 + 0.025 + (i / (moduleCount - 1)) * (W - 0.05)
          parts.push(box(0.015, 0.04, 0.012, x, y, D - 0.006))
        }
      }
      return mergeMeshes(parts)
    },
  },
  'arch-junction-box-cylinder': {
    pivot: 'wall_back_center',
    build: () => {
      // Abzweigdose Kaiser-Style · Zylinder + Deckel + 4 Schrauben
      const parts: ProceduralMesh[] = [
        cyl(0.05, 0.05, 0.04, 0, 0, 0.02, 24), // housing
        cyl(0.052, 0.052, 0.005, 0, 0, 0.042, 24), // cover (slightly larger Ø)
      ]
      // 4 screws at 45° offsets
      const r = 0.035
      for (const angle of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        parts.push(cyl(0.004, 0.004, 0.003, Math.cos(angle) * r, Math.sin(angle) * r, 0.046, 8))
      }
      return mergeMeshes(parts)
    },
  },
  'arch-mirror-cabinet-led': {
    pivot: 'wall_back_center',
    build: () => {
      // Spiegelschrank · Cabinet-Box + Mirror-Front + LED-Strip bottom
      const W = 0.8
      const H = 0.7
      const D = 0.15
      return mergeMeshes([
        box(W, H, D, 0, H / 2, D / 2), // cabinet housing
        box(W - 0.04, H - 0.04, 0.008, 0, H / 2, D - 0.004), // mirror front
        box(W - 0.06, 0.012, 0.008, 0, 0.02, D - 0.002), // LED strip (emissive)
      ])
    },
  },
}

/**
 * The full procedural placeholder table — 10 sanitary + 8 kitchen + 17
 * architecture = 35 slugs (Phase 2 expansion 2026-05-28: +9 DE-Hero refined).
 * Keyed by the catalog slug so the renderer can ask
 * `buildProceduralAsset(asset.slug)` directly.
 */
export const PROCEDURAL_ASSET_SPECS: Readonly<Record<string, ProceduralAssetSpec>> = Object.freeze({
  ...SANITARY_SPECS,
  ...KITCHEN_SPECS,
  ...ARCHITECTURE_SPECS,
})

/** Stable, sorted list of every slug with a procedural placeholder. */
export const PROCEDURAL_ASSET_SLUGS: readonly string[] = Object.freeze(
  Object.keys(PROCEDURAL_ASSET_SPECS).sort(),
)

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The model-space point that the snap engine aligns onto the host surface,
 * derived from the mesh bounds + the pivot convention (`asset.ts` PivotType).
 */
function pivotReferencePoint(bounds: MeshBounds, pivot: PivotType): Vector3 {
  const cx = (bounds.min.x + bounds.max.x) / 2
  const cy = (bounds.min.y + bounds.max.y) / 2
  const cz = (bounds.min.z + bounds.max.z) / 2
  switch (pivot) {
    case 'bottom_center':
      return { x: cx, y: bounds.min.y, z: cz }
    case 'wall_back_center':
      return { x: cx, y: cy, z: bounds.min.z }
    case 'ceiling_top_center':
      return { x: cx, y: bounds.max.y, z: cz }
    case 'corner_back_left':
      return { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z }
    case 'center':
    case 'custom':
      return { x: cx, y: cy, z: cz }
  }
}

function finalizeMesh(slug: string, raw: ProceduralMesh, pivot: PivotType): ProceduralAssetResult {
  const rawBounds = computeMeshBounds(raw)
  const ref = pivotReferencePoint(rawBounds, pivot)
  const mesh = translateMesh(raw, { x: -ref.x, y: -ref.y, z: -ref.z })
  const bbox = computeMeshBounds(mesh)
  return {
    slug,
    mesh,
    bbox,
    dimensions: {
      width_m: round(bbox.max.x - bbox.min.x),
      depth_m: round(bbox.max.z - bbox.min.z),
      height_m: round(bbox.max.y - bbox.min.y),
    },
    pivot,
    triangles: triangleCount(mesh),
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** True when a slug has a hand-authored procedural placeholder. */
export function hasProceduralAsset(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROCEDURAL_ASSET_SPECS, slug)
}

/**
 * Materialise a procedural placeholder by slug, with the pivot reference
 * point translated to the origin. Throws for an unknown slug — callers that
 * may pass furniture / unknown slugs should branch on {@link hasProceduralAsset}
 * or use {@link buildGenericBox}.
 */
export function buildProceduralAsset(slug: string): ProceduralAssetResult {
  const spec = PROCEDURAL_ASSET_SPECS[slug]
  if (!spec) {
    throw new Error(`[spatial] no procedural placeholder for asset slug "${slug}"`)
  }
  return finalizeMesh(slug, spec.build(), spec.pivot)
}

/**
 * Generic dimensioned-box fallback. Used by the renderer when a real GLB
 * (furniture) fails to load, or for any catalog asset without a bespoke
 * placeholder — the cuboid still carries correct size + pivot so collision,
 * clearance and snapping stay accurate.
 */
export function buildGenericBox(
  dimensions: { width_m: number; depth_m: number; height_m: number },
  pivot: PivotType = 'bottom_center',
  slug = 'generic-box',
): ProceduralAssetResult {
  const raw = makeBox(
    { x: dimensions.width_m, y: dimensions.height_m, z: dimensions.depth_m },
    { x: 0, y: dimensions.height_m / 2, z: 0 },
  )
  return finalizeMesh(slug, raw, pivot)
}
