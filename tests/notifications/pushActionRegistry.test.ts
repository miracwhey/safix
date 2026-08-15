import { describe, it, expect } from 'vitest'

import {
  PUSH_ACTION_CATEGORIES,
  isPushActionCategoryId,
  isPushActionId,
} from '../../src/lib/notifications/pushActionRegistry'

/**
 * Schema-Lock: lockt das TS-Spiegel-Schema gegen die iOS-Registrierung in
 * `ios/App/App/AppDelegate.swift::registerNotificationCategories`.
 *
 * Wenn dieser Test bricht, ist entweder die Swift-Datei oder die TS-Datei
 * geändert worden, ohne die andere mitzuziehen. Beide MÜSSEN in sync
 * bleiben — sonst rendert iOS andere Buttons als die App erwartet.
 */
describe('Block A1 · pushActionRegistry — Schema-Lock', () => {
  describe('CORRECTION_DECISION category', () => {
    const category = PUSH_ACTION_CATEGORIES.CORRECTION_DECISION

    it('exposes exactly the APPROVE and REJECT actions, in that order', () => {
      expect(category.actions.map((a) => a.id)).toEqual(['APPROVE', 'REJECT'])
    })

    it('uses the German user-facing titles "Annehmen" and "Ablehnen"', () => {
      expect(category.actions[0].title).toBe('Annehmen')
      expect(category.actions[1].title).toBe('Ablehnen')
    })

    it('forces .foreground + .authenticationRequired on BOTH actions', () => {
      // Sicherheits-Default: keine Background-Mutation, kein Bypass des Device-Locks.
      for (const action of category.actions) {
        expect(action.options.foreground).toBe(true)
        expect(action.options.authenticationRequired).toBe(true)
      }
    })

    it('marks REJECT as destructive (red) and APPROVE as non-destructive', () => {
      const approve = category.actions.find((a) => a.id === 'APPROVE')!
      const reject = category.actions.find((a) => a.id === 'REJECT')!
      expect(approve.options.destructive).toBe(false)
      expect(reject.options.destructive).toBe(true)
    })
  })

  describe('type guards', () => {
    it('isPushActionId narrows APPROVE/REJECT and rejects others', () => {
      expect(isPushActionId('APPROVE')).toBe(true)
      expect(isPushActionId('REJECT')).toBe(true)
      expect(isPushActionId('tap')).toBe(false)
      expect(isPushActionId('')).toBe(false)
      expect(isPushActionId(null)).toBe(false)
      expect(isPushActionId(undefined)).toBe(false)
      expect(isPushActionId(42)).toBe(false)
    })

    it('isPushActionCategoryId recognises only registered categories', () => {
      expect(isPushActionCategoryId('CORRECTION_DECISION')).toBe(true)
      expect(isPushActionCategoryId('UNKNOWN_CATEGORY')).toBe(false)
      expect(isPushActionCategoryId('')).toBe(false)
      expect(isPushActionCategoryId(null)).toBe(false)
    })
  })
})
