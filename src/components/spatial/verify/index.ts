/**
 * Spatial · Verify · Barrel (Phase 3 · Block 3.1-3.8)
 *
 * Public surface of the Customer-Verify-Flow UI (Mockup 15). All five stages
 * are real — the container shell + Welcome / Maße / Layout / Pins / Confirm.
 * {@link VerifyStagePlaceholder} now only stands in for a stage whose scene
 * has not loaded.
 *
 * VF-3 decision (Implementation-Spec §3 · §3.10): the Material-Vorschau is
 * OUT of V1 → V1.x. There is intentionally NO material-picker component in
 * the Customer-Verify-Flow — the customer expresses "hier neue Fliesen" as a
 * `wish` pin (Stage 4 · {@link VerifyStagePins}). No feature code is needed
 * for VF-3; this note is the decision record.
 */

export { VerifySheet, type VerifySheetProps } from './VerifySheet'
export { VerifyStepBar, type VerifyStepBarProps } from './VerifyStepBar'
export { VerifyStageWelcome, type VerifyStageWelcomeProps } from './VerifyStageWelcome'
export {
  VerifyStageMeasure,
  type VerifyStageMeasureProps,
  type VerifyMeasureCorrectionOutcome,
} from './VerifyStageMeasure'
export { VerifyStageLayout, type VerifyStageLayoutProps } from './VerifyStageLayout'
export { VerifyStagePins, type VerifyStagePinsProps } from './VerifyStagePins'
export {
  VerifyStageConfirm,
  type VerifyStageConfirmProps,
  type VerifySubmitAction,
  type VerifySubmitOutcome,
} from './VerifyStageConfirm'
export {
  VerifyPinPicker,
  type VerifyPinPickerProps,
  type VerifyPinKind,
} from './VerifyPinPicker'
export {
  VerifyStagePlaceholder,
  type VerifyStagePlaceholderProps,
} from './VerifyStagePlaceholder'
export { QualityScoreBadge, type QualityScoreBadgeProps } from './QualityScoreBadge'
export {
  MeasureNumericPicker,
  type MeasureNumericPickerProps,
} from './MeasureNumericPicker'
