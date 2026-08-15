import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyChatCutoverUrlOverride,
  isChatCutoverEnabled,
  setChatCutoverOverride,
} from '../../src/lib/chat/featureFlags'

// Node test env: replace localStorage with a complete in-memory shim.
const storage = new Map<string, string>()
const shim = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() {
    return storage.size
  },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: shim,
  writable: true,
  configurable: true,
})

describe('isChatCutoverEnabled', () => {
  beforeEach(() => {
    setChatCutoverOverride('customer', null)
    setChatCutoverOverride('craftsman', null)
    setChatCutoverOverride('worker', null)
  })

  it('defaults to false when neither env nor localStorage are set', () => {
    expect(isChatCutoverEnabled('customer')).toBe(false)
    expect(isChatCutoverEnabled('craftsman')).toBe(false)
    expect(isChatCutoverEnabled('worker')).toBe(false)
  })

  it('localStorage on overrides env false', () => {
    setChatCutoverOverride('customer', 'on')
    expect(isChatCutoverEnabled('customer')).toBe(true)
  })

  it('localStorage off explicit override returns false', () => {
    setChatCutoverOverride('customer', 'off')
    expect(isChatCutoverEnabled('customer')).toBe(false)
  })

  it('clearing override returns false when env is not set', () => {
    setChatCutoverOverride('worker', 'on')
    expect(isChatCutoverEnabled('worker')).toBe(true)
    setChatCutoverOverride('worker', null)
    expect(isChatCutoverEnabled('worker')).toBe(false)
  })

  it('per-persona flags are independent', () => {
    setChatCutoverOverride('customer', 'on')
    setChatCutoverOverride('worker', 'off')
    expect(isChatCutoverEnabled('customer')).toBe(true)
    expect(isChatCutoverEnabled('craftsman')).toBe(false)
    expect(isChatCutoverEnabled('worker')).toBe(false)
  })
})

describe('applyChatCutoverUrlOverride', () => {
  // Minimal window stub — applyChatCutoverUrlOverride only touches
  // window.location.{search,pathname,hash} and window.history.replaceState.
  const replaceStateCalls: Array<[unknown, string, string]> = []
  const stubWindow = (search: string) => {
    const win = {
      location: { search, pathname: '/messages', hash: '' },
      history: {
        replaceState: (data: unknown, title: string, url: string) => {
          replaceStateCalls.push([data, title, url])
        },
      },
    }
    Object.defineProperty(globalThis, 'window', {
      value: win,
      writable: true,
      configurable: true,
    })
  }
  const teardownWindow = () => {
    delete (globalThis as unknown as { window?: unknown }).window
  }

  beforeEach(() => {
    setChatCutoverOverride('customer', null)
    setChatCutoverOverride('craftsman', null)
    setChatCutoverOverride('worker', null)
    replaceStateCalls.length = 0
  })

  it('writes localStorage on, off, and clear', () => {
    stubWindow('?chat_cutover_customer=on&chat_cutover_worker=off&chat_cutover_craftsman=clear')
    setChatCutoverOverride('craftsman', 'on') // pre-existing
    applyChatCutoverUrlOverride()
    expect(isChatCutoverEnabled('customer')).toBe(true)
    expect(isChatCutoverEnabled('worker')).toBe(false)
    expect(isChatCutoverEnabled('craftsman')).toBe(false) // cleared
    teardownWindow()
  })

  it('removes recognised params from URL via replaceState', () => {
    stubWindow('?chat_cutover_customer=on&keep=yes')
    applyChatCutoverUrlOverride()
    expect(replaceStateCalls.length).toBe(1)
    expect(replaceStateCalls[0][2]).toBe('/messages?keep=yes')
    teardownWindow()
  })

  it('is a no-op when no chat_cutover params are present', () => {
    stubWindow('?other=1')
    applyChatCutoverUrlOverride()
    expect(replaceStateCalls.length).toBe(0)
    teardownWindow()
  })

  it('treats empty / unknown values as clear', () => {
    setChatCutoverOverride('customer', 'on')
    stubWindow('?chat_cutover_customer=')
    applyChatCutoverUrlOverride()
    expect(isChatCutoverEnabled('customer')).toBe(false)
    teardownWindow()
  })
})
