/**
 * Spatial · Canonical Room Scene Data Model (L1 Pure-Logic Foundation)
 *
 * Public API barrel for the canonical scene-graph + algebra + geometry +
 * validator + overrides + schema + converters.
 *
 * IMPORTANT: This module must remain free of three.js, React, and DOM
 * dependencies. It is the renderer-agnostic L1 foundation that every
 * downstream layer (storage, renderer, edit-system) consumes.
 *
 * See README.md in this folder for architecture details and the 4-Layer
 * Spatial-V1 model. Build sequence is tracked in
 * `~/.claude/plans/federated-purring-sutherland.md`.
 */

// Types (Day 1 · A2-A4)
export * from './types/index.ts'

// Algebra (Day 2 · A5-A8)
export * from './algebra/index.ts'

// Geometry (Day 3 · A9-A13 · + Day 18 procedural placeholders)
export * from './geometry/index.ts'

// Snap (Day 18 · asset placement rules + resolvers)
export * from './snap/index.ts'

// Cache (Day 18 · OQ-13 shared refCount asset cache)
export * from './cache/asset-cache.ts'

// Catalog (Day 18-20 · asset + material registries + LOD)
export * from './catalog/index.ts'

// Lighting (Day 22 · 8 HDRI presets)
export * from './lighting/index.ts'

// Validator (Day 4 · A14-A18)
export * from './validator/index.ts'

// Overrides (Day 4 · A17)
export * from './overrides/index.ts'

// Schema (Day 5 · A19-A20)
export * from './schema/index.ts'

// Converters (Day 5 · A21-A22)
export * from './converters/index.ts'

// Bridge (Day 8 · B13)
export * from './bridge/index.ts'
