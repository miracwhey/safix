import { useCallback, useMemo, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Haptics,
  ImpactStyle,
  NotificationType,
} from '@capacitor/haptics';

/**
 * Haptic mode keys exposed by {@link useHaptics}.
 *
 * - `selection` — light tick for picker/segmented changes (UISelectionFeedbackGenerator)
 * - `light`     — small UI collision (e.g. toggle, chip select)
 * - `medium`    — moderate UI collision (e.g. snap-acquire during drag)
 * - `heavy`     — large UI collision (e.g. snap-lock, primary CTA confirm)
 * - `success`   — notification: task completed
 * - `warning`   — notification: caution / non-destructive issue
 * - `error`     — notification: task failed / destructive reject
 */
export type HapticMode =
  | 'selection'
  | 'light'
  | 'medium'
  | 'heavy'
  | 'success'
  | 'warning'
  | 'error';

const THROTTLE_MS = 200;

const isNativeHapticsAvailable = (): boolean => {
  // Web `HapticsWeb` throws `unavailable` on browsers without `navigator.vibrate`
  // (Safari desktop, Firefox desktop). Guard to native platforms only — UX
  // does not benefit from desktop vibration anyway, and Android Web view goes
  // through the native bridge so `getPlatform()` returns 'android' there.
  if (!Capacitor.isPluginAvailable('Haptics')) return false;
  const p = Capacitor.getPlatform();
  return p === 'ios' || p === 'android';
};

const fireNative = async (mode: HapticMode): Promise<void> => {
  // Native generators (`UIImpactFeedbackGenerator`,
  // `UINotificationFeedbackGenerator`, `UISelectionFeedbackGenerator`) are
  // safe on iOS Simulator: they silently no-op instead of throwing.
  // Only `vibrate(duration)` touches `CHHapticEngine`, which can throw on
  // Simulator — we don't use it here. We still wrap in try/catch as belt
  // and suspenders so a bridge hiccup never bubbles to UI handlers.
  try {
    switch (mode) {
      case 'selection':
        await Haptics.selectionStart();
        await Haptics.selectionChanged();
        await Haptics.selectionEnd();
        return;
      case 'light':
        await Haptics.impact({ style: ImpactStyle.Light });
        return;
      case 'medium':
        await Haptics.impact({ style: ImpactStyle.Medium });
        return;
      case 'heavy':
        await Haptics.impact({ style: ImpactStyle.Heavy });
        return;
      case 'success':
        await Haptics.notification({ type: NotificationType.Success });
        return;
      case 'warning':
        await Haptics.notification({ type: NotificationType.Warning });
        return;
      case 'error':
        await Haptics.notification({ type: NotificationType.Error });
        return;
    }
  } catch {
    // Swallow: haptics are an enhancement, never a hard requirement.
  }
};

export interface UseHapticsApi {
  /** Fire a haptic by mode. Per-mode throttled to ≥200ms; cross-mode allowed. */
  trigger: (mode: HapticMode) => void;
  /** Convenience shorthands. Same throttle semantics as `trigger`. */
  selection: () => void;
  light: () => void;
  medium: () => void;
  heavy: () => void;
  success: () => void;
  warning: () => void;
  error: () => void;
  /** Whether the host platform will actually produce haptics. */
  isAvailable: boolean;
}

/**
 * Sim-safe, web-safe, per-mode throttled haptics hook.
 *
 * Throttle is **per mode** so a snap-acquire (`medium`) + snap-lock (`heavy`)
 * combo within 100ms both fire (different buckets), while two `medium` taps in
 * 50ms collapse to one (same bucket). Bucket is held in a `useRef` Map so the
 * component never re-renders on a haptic fire.
 */
export function useHaptics(): UseHapticsApi {
  const lastFiredRef = useRef<Map<HapticMode, number>>(new Map());
  const isAvailable = useMemo(() => isNativeHapticsAvailable(), []);

  const trigger = useCallback(
    (mode: HapticMode): void => {
      if (!isAvailable) return;
      const now = Date.now();
      const last = lastFiredRef.current.get(mode) ?? 0;
      if (now - last < THROTTLE_MS) return;
      lastFiredRef.current.set(mode, now);
      // Fire-and-forget; we never await haptics from UI handlers.
      void fireNative(mode);
    },
    [isAvailable]
  );

  return useMemo<UseHapticsApi>(
    () => ({
      trigger,
      selection: () => trigger('selection'),
      light: () => trigger('light'),
      medium: () => trigger('medium'),
      heavy: () => trigger('heavy'),
      success: () => trigger('success'),
      warning: () => trigger('warning'),
      error: () => trigger('error'),
      isAvailable,
    }),
    [trigger, isAvailable]
  );
}
