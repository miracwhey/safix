import type { Conversation, Message } from './types'
import { getMessageRepository } from './repository'

export function subscribeMessages(listener: () => void): () => void {
  return getMessageRepository().subscribe(listener)
}

export function getConversations(): Conversation[] {
  return getMessageRepository().getConversations()
}

export function getConversationById(conversationId: string): Conversation | undefined {
  return getMessageRepository().getConversationById(conversationId)
}

export function getConversationByProjectId(projectId: string): Conversation | undefined {
  return getMessageRepository().getConversationByProjectId(projectId)
}

export function getMessages(): Message[] {
  return getMessageRepository().getMessages()
}

export function getMessagesByConversationId(conversationId: string): Message[] {
  return getMessageRepository().getMessagesByConversationId(conversationId)
}
