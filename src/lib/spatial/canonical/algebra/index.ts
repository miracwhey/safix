/**
 * Spatial · Canonical · Algebra · Barrel
 *
 * Public surface of the algebra layer: matrices, quaternions, and
 * transform helpers. Importing from this barrel keeps callers decoupled
 * from the internal file split (matrix.ts vs quaternion.ts vs transform.ts).
 */

export * from './matrix.ts'
export * from './quaternion.ts'
export * from './transform.ts'
export * from './time.ts'
