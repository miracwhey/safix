import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type AudioSessionContextValue = {
  unmuted: boolean
  toggle: () => void
  mute: () => void
}

const AudioSessionContext = createContext<AudioSessionContextValue | null>(null)

export function AudioSessionProvider({ children }: { children: ReactNode }) {
  const [unmuted, setUnmuted] = useState(false)
  // Stable callbacks + memoized context value: without this the provider hands
  // a fresh value object on every render, so every memo()'d ExploreReelCard
  // re-renders whenever the provider's parent re-renders (not just on a real
  // mute toggle). Identity now changes only when `unmuted` actually flips.
  const toggle = useCallback(() => setUnmuted((prev) => !prev), [])
  const mute = useCallback(() => setUnmuted(false), [])
  const value = useMemo<AudioSessionContextValue>(
    () => ({ unmuted, toggle, mute }),
    [unmuted, toggle, mute],
  )

  return createElement(AudioSessionContext.Provider, { value }, children)
}

export function useAudioSession(): AudioSessionContextValue {
  const ctx = useContext(AudioSessionContext)
  if (ctx === null) {
    throw new Error('useAudioSession must be used within <AudioSessionProvider>')
  }
  return ctx
}
