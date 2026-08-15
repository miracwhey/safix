import { registerPlugin } from '@capacitor/core'
import type { LiquidGlassPlugin } from './definitions'
import { LiquidGlassWeb } from './web'

const LiquidGlass = registerPlugin<LiquidGlassPlugin>('LiquidGlass', {
  web: () => new LiquidGlassWeb(),
})

export { LiquidGlass }
export type {
  LiquidGlassPlugin,
  LiquidGlassAvailability,
  GlassStyle,
  GlassRect,
  PresentGlassOptions,
  UpdateGlassOptions,
  RemoveGlassOptions,
} from './definitions'
