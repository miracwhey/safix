/**
 * Spatial · Canonical · Validator · Orchestrator
 *
 * Runs every rule registered in `rules/index.ts` against the supplied scene
 * and returns a single aggregated {@link ValidationReport}. Pure-function;
 * never throws.
 *
 * Phase-2 edit-system will subscribe to scene mutations and call
 * `runValidator` debounced; for now (Phase-0a) the function is invoked
 * eagerly during the bridge (`scanToParametric.ts`, Day 8 B13) and from the
 * adapters before render.
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { ValidationReport } from '../types/validation.ts'
import { ALL_RULES } from './rules/index.ts'
import { buildReport } from './report-format.ts'

export function runValidator(scene: RoomScene): ValidationReport {
  const issues = ALL_RULES.flatMap(rule => rule(scene))
  return buildReport(scene, issues)
}
