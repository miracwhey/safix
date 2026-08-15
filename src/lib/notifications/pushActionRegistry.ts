/**
 * Push-Action Registry · Block A1
 *
 * TS-Spiegel der iOS Notification-Categories aus
 * `ios/App/App/AppDelegate.swift::registerNotificationCategories`. Single
 * source of truth für die Action-Buttons, die iOS auf dem Lockscreen rendert.
 *
 * iOS rendert die Buttons nur, wenn der Push-Payload `aps.category` auf einen
 * der hier registrierten Identifier setzt (siehe Edge-Function `notify-push`).
 *
 * Drift-Schutz: `pushActionRegistry.test.ts` lockt das Schema. Wenn der Swift-
 * Code geändert wird (anderer Identifier, anderer Title, andere Options),
 * muss diese Datei mitziehen — sonst bricht der Schema-Lock-Test.
 */
export type PushActionId = 'APPROVE' | 'REJECT'

export type PushActionOptions = {
  /** Öffnet die App beim Action-Tap (immer Pflicht im MVP). */
  foreground: boolean
  /** Verlangt Face-ID/Code falls Device gesperrt — gegen Lockscreen-Versehen. */
  authenticationRequired: boolean
  /** Roter Button-Style (für REJECT). */
  destructive: boolean
}

export type PushActionDescriptor = {
  readonly id: PushActionId
  readonly title: string
  readonly options: PushActionOptions
}

export type PushActionCategory = {
  readonly actions: ReadonlyArray<PushActionDescriptor>
}

/**
 * Categories, die in iOS registriert sind. Identifier MUSS exakt mit dem
 * `category`-String in der APNs-Payload (`aps.category`) und mit dem
 * `UNNotificationCategory.identifier` in AppDelegate.swift übereinstimmen.
 */
export const PUSH_ACTION_CATEGORIES = {
  CORRECTION_DECISION: {
    actions: [
      {
        id: 'APPROVE',
        title: 'Annehmen',
        options: {
          foreground: true,
          authenticationRequired: true,
          destructive: false,
        },
      },
      {
        id: 'REJECT',
        title: 'Ablehnen',
        options: {
          foreground: true,
          authenticationRequired: true,
          destructive: true,
        },
      },
    ],
  },
} as const satisfies Record<string, PushActionCategory>

export type PushActionCategoryId = keyof typeof PUSH_ACTION_CATEGORIES

export function isPushActionId(value: unknown): value is PushActionId {
  return value === 'APPROVE' || value === 'REJECT'
}

export function isPushActionCategoryId(value: unknown): value is PushActionCategoryId {
  return typeof value === 'string' && value in PUSH_ACTION_CATEGORIES
}
