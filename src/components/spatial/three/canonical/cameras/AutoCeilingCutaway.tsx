/**
 * Spatial · Canonical · Cameras · AutoCeilingCutaway (V1.6.1 Round 7)
 *
 * Versteckt die Decke automatisch wenn der User im Dollhouse-Mode von oben
 * in den Raum schaut — analog zum bestehenden Wand-Cutaway (SectionClipper)
 * aber komplett autonom über `controls.getPolarAngle()`.
 *
 * Threshold-Werte (rad):
 *   - > 0.75 rad (≈43°): Decke sichtbar (User schaut horizontal)
 *   - < 0.55 rad (≈31°): Decke versteckt (User schaut top-down)
 *   - dazwischen: Hysterese (kein Flip-Flop bei border-line)
 *
 * Implementation: poll-via-useFrame statt event-listener, weil drei
 * OrbitControls keinen polar-angle-change event emittet.
 *
 * Schreibt in `cutawaySetting` Store-State (bestehend) — der CeilingAdapter
 * liest `ceilingHidden` aus dem Store + setzt mesh.visible accordingly.
 * Beim Unmount (Mode-Wechsel weg von Dollhouse) wird das Cutaway zurück-
 * gesetzt damit andere Modes (Walk/Floorplan) nicht in halb-clipped state
 * landen.
 */

import { useEffect, useRef, type ReactElement } from 'react'
import { useFrame, useThree } from '@react-three/fiber'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'

// R8-B 2026-05-28: User: "Decke schon ein bisschen flacher wegmachen".
// Vorher 0.55/0.75 = nur bei sehr top-down (<31°) Decke aus. Jetzt 1.0/1.2
// = schon bei mäßig schrägem Blick (<57° vom Lot) → Decke aus. Hysterese
// 0.2 rad verhindert Flicker an der Grenze.
const HIDE_BELOW_RAD = 1.0 // ≈57° vom Lot — moderat-schräg → hide
const SHOW_ABOVE_RAD = 1.2 // ≈69° — fast horizontal → show

interface OrbitControlsLike {
  getPolarAngle?(): number
}

export function AutoCeilingCutaway(): ReactElement | null {
  const controls = useThree((s) => s.controls as OrbitControlsLike | null)
  const setCutawaySetting = useCanonicalSceneStore((s) => s.setCutawaySetting)
  const lastSettingRef = useRef<'none' | 'remove_ceiling'>('none')

  // Beim Unmount auf 'none' zurück damit Walk/Floorplan saubere Decke sehen.
  useEffect(() => {
    return () => {
      if (lastSettingRef.current !== 'none') {
        setCutawaySetting('none')
        lastSettingRef.current = 'none'
      }
    }
  }, [setCutawaySetting])

  useFrame(() => {
    if (!controls || typeof controls.getPolarAngle !== 'function') return
    const polar = controls.getPolarAngle()
    if (polar < HIDE_BELOW_RAD && lastSettingRef.current !== 'remove_ceiling') {
      setCutawaySetting('remove_ceiling')
      lastSettingRef.current = 'remove_ceiling'
    } else if (polar > SHOW_ABOVE_RAD && lastSettingRef.current !== 'none') {
      setCutawaySetting('none')
      lastSettingRef.current = 'none'
    }
  })

  return null
}

export default AutoCeilingCutaway
