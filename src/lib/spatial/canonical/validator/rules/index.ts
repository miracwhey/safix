/**
 * Spatial · Canonical · Validator · Rule Registry
 *
 * Exports all rule modules + a flat composite list consumed by
 * `run-validator.ts` to iterate them in a single pass.
 */

import { WALL_RULES } from './wall-rules.ts'
import { OPENING_RULES } from './opening-rules.ts'
import { OBJECT_RULES } from './object-rules.ts'
import { PIN_RULES } from './pin-rules.ts'
import { ROOM_RULES } from './room-rules.ts'

import type { RoomScene } from '../../types/scene-graph.ts'
import type { ValidationIssue } from '../../types/validation.ts'

export type RuleFn = (scene: RoomScene) => ValidationIssue[]

export const ALL_RULES: ReadonlyArray<RuleFn> = [
  ...WALL_RULES,
  ...OPENING_RULES,
  ...OBJECT_RULES,
  ...PIN_RULES,
  ...ROOM_RULES,
]

export * from './wall-rules.ts'
export * from './opening-rules.ts'
export * from './object-rules.ts'
export * from './pin-rules.ts'
export * from './room-rules.ts'
