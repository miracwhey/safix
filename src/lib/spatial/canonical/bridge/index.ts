/**
 * Spatial · Canonical · Bridge · Barrel
 *
 * The bridge layer is the legal seam between Block-A's capture-side types
 * (`src/lib/spatial/types.ts`) and the canonical L1 scene-graph. Day 8 B13
 * ships `scanToParametric.ts` (dormant per AD-1); `getCanonicalScene.ts` wraps
 * the authoritative iOS-native converter.
 */

export * from './scanToParametric.ts'
export * from './getCanonicalScene.ts'
