/**
 * Provider Assignment Consistency Tests
 *
 * Verifies that when a quote is accepted, the provider/craftsman
 * relationship is consistently reflected across all surfaces:
 *   - Job has provider assigned
 *   - Project has craftsman name
 *   - Escrow plan has correct provider
 *   - No surface shows "no craftsman assigned" when the accepted
 *     quote has already anchored the provider relationship
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addConversation } from '../../src/lib/messages'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { getProjectByJobId, getProjects } from '../../src/lib/projects'
import { getEscrowPlanByOfferId } from '../../src/lib/payments/escrow'
import type { Conversation } from '../../src/lib/messages/types'

function makeConversation(id = 'conv-assign-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-assign',
    craftsmanName: 'Hans Handwerker GmbH',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-assign',
    projectTitle: 'Küche renovieren',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'München',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

describe('Provider Assignment Consistency', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('job has provider assigned after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-assign',
      craftsmanUserId: 'craftsman-assign',
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(job.craftsmanUserId).toBe('craftsman-assign')
    expect(job.sourceOfferId).toBe(offer.id)
  })

  it('project reflects craftsman name after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-assign',
      craftsmanUserId: 'craftsman-assign',
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    const project = getProjectByJobId(accepted.createdJobId!)

    expect(project).toBeDefined()
    expect(project!.craftsman).toBe('Hans Handwerker GmbH')
    expect(project!.craftsmanUserId).toBe('craftsman-assign')
  })

  it('escrow plan has correct provider ID after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-assign',
      craftsmanUserId: 'craftsman-assign',
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)

    expect(plan).toBeDefined()
    expect(plan!.customerUserId).toBe('customer-assign')
    // providerId comes from job.providerId ?? offer.craftsmanUserId
    expect(plan!.providerId).toBe('craftsman-assign')
  })

  it('no surface shows "no craftsman" when provider is assigned through accepted quote', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-assign',
      craftsmanUserId: 'craftsman-assign',
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!

    // All projects should have a craftsman
    const projects = getProjects()
    const linkedProject = projects.find((p) => p.sourceJobId === accepted.createdJobId)
    expect(linkedProject).toBeDefined()
    expect(linkedProject!.craftsman).toBeTruthy()
    expect(linkedProject!.craftsman).not.toBe('')
    expect(linkedProject!.craftsmanUserId).toBeTruthy()
  })

  it('re-acceptance is idempotent and keeps provider assignment consistent', async () => {
    const conv = makeConversation('conv-reaccept')
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-assign',
      craftsmanUserId: 'craftsman-assign',
      price: '2.500 €',
    })

    // Accept first time
    await acceptOfferWorkflow(offer.id)
    const firstJob = getOfferById(offer.id)!.createdJobId!

    // Accept again (idempotent re-entry)
    await acceptOfferWorkflow(offer.id)
    const secondJob = getOfferById(offer.id)!.createdJobId!

    expect(secondJob).toBe(firstJob)

    const job = getJobById(firstJob)!
    expect(job.craftsmanUserId).toBe('craftsman-assign')
  })
})
