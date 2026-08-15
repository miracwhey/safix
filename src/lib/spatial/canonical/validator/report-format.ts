/**
 * Spatial · Canonical · Validator · Report Format
 *
 * Helpers to bucket {@link ValidationIssue}s into a {@link ValidationReport}
 * and to fold over its flags.
 *
 * Risk R7 mitigation lives here: the report carries BOTH
 *   - `is_renderable`              (graceful · floor + ≥3 walls suffice)
 *   - `requires_user_confirmation` (strict · any error blocks quote/BoM)
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { ValidationIssue, ValidationReport, ValidationSeverity } from '../types/validation.ts'

export function buildReport(scene: RoomScene, issues: ValidationIssue[]): ValidationReport {
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')
  const hints = issues.filter(i => i.severity === 'hint')

  const hasFloorAndWalls = Boolean(scene.floor?.polygon && scene.floor.polygon.length >= 3) && scene.walls.length >= 3
  const wallHeightSane = scene.walls.every(w => w.height_m > 0)

  return {
    scene_id: scene.id,
    validated_at: new Date().toISOString(),
    errors,
    warnings,
    hints,
    is_renderable: hasFloorAndWalls,
    is_walkable: hasFloorAndWalls && wallHeightSane && errors.length === 0,
    requires_user_confirmation: errors.length > 0,
  }
}

export function isIssueOfSeverity(issue: ValidationIssue, severity: ValidationSeverity): boolean {
  return issue.severity === severity
}
