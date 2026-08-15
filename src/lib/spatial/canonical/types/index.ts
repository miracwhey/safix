/**
 * Spatial · Canonical · Types · Barrel
 *
 * Re-exports the complete canonical-type surface for the L1 Pure-Logic
 * Foundation. Consumers should import from this barrel (or from the
 * package root `@/lib/spatial/canonical`) rather than reaching into the
 * individual files — the file layout is an implementation detail.
 */

// A2 · Primitives (Day 1)
export * from './primitives.ts'

// A3 · Scene-Graph + Geometry + Objects (Day 1)
export * from './scene-graph.ts'
export * from './geometry.ts'
export * from './objects.ts'

// A4 · Walkable + Camera + Annotations + Variants + Asset + Validation (Day 1)
export * from './walkable.ts'
export * from './camera.ts'
export * from './annotations.ts'
export * from './variants.ts'
export * from './asset.ts'
export * from './validation.ts'

// Edit-Command types (Phase 2 · Pre-2 · command-pattern edit-system)
export * from './commands.ts'

// Errors (Day 5 hardening · XM-6/H11 audit-fix · base class only · subclasses in Day 8)
export * from './errors.ts'
