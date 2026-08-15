/**
 * Global test setup — mocks external network services.
 *
 * Prevents any test from making real HTTP/DNS requests to the placeholder
 * Supabase URL configured in vitest.config.ts.
 *
 * Primary target: `providerProfileService.getProviderProfile()` which is
 * called during `acceptOfferWorkflow → resolveProviderId` and would
 * otherwise hang on DNS resolution in CI environments.
 */

import { vi } from 'vitest'

// Every test file starts from the hermetic in-memory runtime, independent of
// the developer's production-like .env.local. Individual tests may override
// these values with vi.stubEnv when they explicitly exercise another mode.
vi.stubEnv('VITE_DATA_SOURCE', 'in-memory')
vi.stubEnv('VITE_API_BASE_URL', '')
vi.stubEnv('VITE_STRIPE_BACKEND_URL', '')
vi.stubEnv('VITE_CHAT_UI_CUTOVER_CUSTOMER', 'false')
vi.stubEnv('VITE_CHAT_UI_CUTOVER_CRAFTSMAN', 'false')
vi.stubEnv('VITE_CHAT_UI_CUTOVER_WORKER', 'false')

vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  getProviderCompanyNameById: vi.fn().mockResolvedValue(null),
  // acceptOfferWorkflow → resolveProviderId resolves through this in prod
  // (SECURITY DEFINER RPC). Mocked to null so in-memory tests keep the
  // craftsmanUserId fallback path and never hit real DNS.
  getProviderIdByAuthUid: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
  // Block 7.1B1: tax/bank-Pfad bleibt im Default-Mock ein No-op, damit
  // bestehende Tests, die das Profil-Modul nur passieren, nicht brechen.
  updateProviderTaxProfile: vi.fn().mockResolvedValue(undefined),
  PROVIDER_LEGAL_FORMS: [
    'einzelunternehmer',
    'gbr',
    'gmbh',
    'ug',
    'ag',
    'kg',
    'ohg',
    'sonstige',
  ] as const,
}))
