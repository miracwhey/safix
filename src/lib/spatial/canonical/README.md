# Spatial · Canonical Room Scene Data Model (L1 Pure-Logic Foundation)

**Status:** in progress (Phase 0a · Day 1-5 · Build started 2026-05-20)
**Layer:** L1 of 4-Layer Spatial-V1-Architecture
**Mission:** robust, renderer-agnostic, future-proof Foundation for SaFix's 3D-Engine

---

## What this module is

The **canonical** module defines SaFix's single, authoritative in-memory representation of a captured room scene. It is the foundation that every downstream layer (storage, renderer, edit-system) consumes.

**Properties:**

- **Zero runtime dependencies on three.js, React, or DOM.** This module must run in any TypeScript environment (Node, Worker, Bundler, future WebGPU-native engine).
- **Pure functions only.** Side-effect free except in explicit `repository/` and `storage/` sub-modules (added in Phase 0b).
- **Renderer-agnostic.** The same scene-graph drives three.js (web), RealityKit (iOS V1.x), or any future renderer.
- **Schema-versioned.** `parametric.json` storage format carries `schema_version` for forward-compatible migrations.

---

## Architecture (4-Layer Foundation)

```
┌────────────────────────────────────────────────────────────────┐
│ L4 · Edit-System (Phase 2 · Day 24-27)                        │
│      src/lib/spatial/commands/ · Command-Pattern + Undo       │
└────────────────────────────────────────────────────────────────┘
                          ▲ writes to active variant
                          │
┌────────────────────────────────────────────────────────────────┐
│ L3 · Renderer-Adapter (Phase 0c · Day 10-12)                  │
│      src/components/spatial/three/canonical/                   │
│      r3f + WebGL2 + Adapters (swappable per renderer)         │
└────────────────────────────────────────────────────────────────┘
                          ▲ reads scene-graph
                          │
┌────────────────────────────────────────────────────────────────┐
│ L2 · Data-Contracts (Phase 0b · Day 6-9)                      │
│      canonical/{storage,bridge,repository}/                    │
│      parametric.json gzipped · spatial_scenes Postgres        │
│      scanToParametric Bridge from Block-A                     │
│      Swift CanonicalConverter (iOS native)                    │
└────────────────────────────────────────────────────────────────┘
                          ▲ consumes pure-logic
                          │
┌────────────────────────────────────────────────────────────────┐
│ L1 · Pure-Logic Foundation (THIS MODULE · Day 1-5)            │
│      canonical/{types,algebra,geometry,validator,overrides,   │
│                 schema,converters}/                            │
│      ZERO three.js/React/DOM deps                              │
└────────────────────────────────────────────────────────────────┘
```

---

## Module Layout

```
src/lib/spatial/canonical/
├── README.md                 # this file
├── index.ts                  # public-API barrel
│
├── types/                    # Day 1 (A2-A4)
│   ├── primitives.ts         # Vector3, Quaternion, Transform, Matrix4
│   ├── scene-graph.ts        # Node, Project, Building, RoomScene
│   ├── geometry.ts           # Wall, Floor, Ceiling, WallOpening
│   ├── objects.ts            # SpatialObject, ObjectCategory, ObjectHost
│   ├── walkable.ts           # WalkableArea, CollisionVolume, CameraCapsule, DoorPortal, RoomConnectivityGraph
│   ├── camera.ts             # CameraMode, CameraPreset, VisibilityFilter
│   ├── annotations.ts        # Pin, Photo, Note
│   ├── variants.ts           # Variant, NodeOverride
│   ├── asset.ts              # Asset, Material, Pivot, SnapRule, ClearanceZone
│   ├── validation.ts         # ValidationReport, ValidationIssue, code-unions
│   └── index.ts              # barrel
│
├── algebra/                  # Day 2 (A5-A8)
│   ├── matrix.ts             # composeMatrix, decomposeMatrix, multiplyMatrix
│   ├── quaternion.ts         # normalize, multiply, slerp, fromEuler, toEuler
│   └── transform.ts          # compose, decompose, parentRelativeResolve, worldTransformCompute (cached)
│
├── geometry/                 # Day 3 (A9-A13)
│   ├── wall-geometry.ts      # lengthCompute, normalCompute, polygonFromWall, polygonFromWallFootprint
│   ├── door-portal.ts        # portalPolygonCompute, findHostWall (R11 tolerance), findOverlappingWalls
│   ├── walkable.ts           # computeWalkableArea via polygon-clipping
│   └── collision.ts          # capsuleVsBox, slideAlongWall, resolveCameraCollision (R14 Y-clamp fallback)
│
├── validator/                # Day 4 (A14-A18)
│   ├── rules/
│   │   ├── wall-rules.ts
│   │   ├── opening-rules.ts
│   │   ├── object-rules.ts
│   │   ├── pin-rules.ts
│   │   ├── room-rules.ts
│   │   └── index.ts          # registry
│   ├── run-validator.ts      # R7: both is_renderable + requires_user_confirmation
│   └── report-format.ts
│
├── overrides/                # Day 4 (A17)
│   ├── layer-merge.ts        # mergeOverrides pure
│   ├── variant-resolve.ts    # resolveNode, resolveScene
│   ├── diff-variants.ts      # compare variants → DiffReport
│   └── cache.ts              # R8: WeakMap cache per-scene/per-variant, invalidate-on-edit
│
├── schema/                   # Day 5 (A19-A20)
│   ├── parametric-json-schema.ts  # JSON-Schema-Draft-07 for ParametricJson
│   ├── ajv-validator.ts           # compiled ajv-validator instance
│   └── version-migration.ts       # schema_version upgrade-paths
│
└── converters/               # Day 5 (A21-A22)
    ├── roomplan-to-canonical.ts   # TS-mirror of Swift CanonicalConverter
    └── canonical-roundtrip.ts     # serialize ⇌ deserialize
```

---

## Conventions (binding, mirrors SaFix Block-A patterns)

### Tests
- Location: `tests/lib/spatial/canonical/**/*.test.ts` (top-level per `vitest.config.ts:20`)
- Naming: `.test.ts` (NOT `.spec.ts`)
- Fixtures: `tests/lib/spatial/canonical/__fixtures__/*.json`

### TS-Types
- **String-union enums**, NOT TypeScript enums. Mirror DB CHECK constraints with `// CHECK: ...` comment.
- **Single types.ts per sub-folder is the SaFix convention.** For L1's breadth we use `types/` sub-folder with thematic split + barrel-export via `types/index.ts`. Public API still imported as `from '@/lib/spatial/canonical'` (single surface).
- Plain interfaces, no classes. Errors are the one exception (custom Error subclass with `.code` property).

### Error-Handling
Throw custom `Error` subclass with `.code` string property (mirrors Postgres errcodes for unified catch). Pattern from `src/lib/spatial/repository/fsm.ts:46-61` (ScanFsmViolation).

### Pure-Function Split
Follow `src/lib/spatial/quality/{rules,qualityEngine}.ts` pattern:
- `rules.ts` (or `rules/`): threshold constants + rule-functions (pure, deterministic)
- `engine.ts` (or `run-*.ts`): orchestration that composes rules into an output report

### No `three.js` / no `react` imports
Enforced by ESLint rule (added later) + by grep-check in Phase 0a DoD (Day 5 A25).

### Coordinate-System
Right-Handed Y-Up (compatible with RoomPlan + three.js + glTF). Unit = Meters everywhere.

---

## Risk-Register Pointer

15 logic-gaps identified during planning are tracked in `~/.claude/plans/federated-purring-sutherland.md` §3 and addressed across the Day 1-17 plan. Cross-reference each block in the Plan-File for which risk it mitigates.

---

## Build-Progress (Phase 0a · DONE 2026-05-20)

| Day | Phase | Tests | Status |
|---|---|---|---|
| Day 1 | A1-A4 Repo + Types | — | ✅ |
| Day 2 | A5-A8 Algebra | 55 | ✅ |
| Day 3 | A9-A13 Geometry + Walkable | 49 | ✅ |
| Day 4 | A14-A18 Validator + Overrides | 70 | ✅ |
| Day 5 | A19-A25 Schema + Converters | 19 | ✅ |

**Cumulative:** 193 canonical tests · 315 full spatial tests · 0 ESLint errors · 0 three.js imports in L1 · TS build clean.

**Hard-Pause-Gate reached.** User-review of the public API surface invited before Phase 0b (L2 data-contracts + bridge) starts on Day 6.

## Public API surface (Phase 0a)

```ts
import {
  // Types
  Vector3, Quaternion, Transform, Matrix4,
  Node, Project, Building, RoomScene,
  Wall, Floor, Ceiling, WallOpening,
  SpatialObject, ObjectCategory, ObjectHost,
  Pin, Photo, Note,
  WalkableArea, WalkablePolygon, CollisionVolume, CameraCapsule,
  CameraMode, CameraPreset, CAMERA_PRESETS,
  Variant, NodeOverride, STANDARD_VARIANTS,
  Asset, Material, Pivot, SnapRule,
  ValidationReport, ValidationIssue, ValidationCode,

  // Algebra
  composeMatrix, decomposeMatrix, multiplyMatrix, inverseMatrix,
  fromAxisAngle, fromEuler, toEuler, slerp, normalize, multiply, rotateVector,
  composeTransform, worldTransformCompute, invalidateWorldTransformCache,

  // Geometry
  lengthCompute, normalCompute, polygonFromWall, polygonFromWallFootprint,
  portalPolygonCompute, findHostWall, findOverlappingWalls,
  computeWalkableArea, walkablePolygonAreaM2,
  capsuleVsBox, slideAlongWall, resolveCameraCollision, isPointInWalkable,

  // Validator
  runValidator, ALL_RULES, WALL_RULES, ROOM_RULES, /* ... */

  // Overrides
  mergeOverrides, resolveScene, resolveNode, diffVariants,
  createOverrideCache, resolveSceneCached, invalidateVariant,

  // Schema + Converters
  validateParametricJson, migrateParametricJson, CURRENT_SCHEMA_VERSION,
  convertRoomPlanToCanonical, serialize, deserialize,
} from '@/lib/spatial/canonical'
```

---

## See Also

- `~/.claude/plans/federated-purring-sutherland.md` — approved Detail-Plan (76 blocks)
- `~/.claude/plans/spatial-v1-day-1-17-NEXT-CHAT-HANDOVER.md` — Master-Handover
- `~/.claude/plans/spatial-v1-canonical-room-data-model.md` — Master-Spec (1331 LOC binding · §1-§19)
