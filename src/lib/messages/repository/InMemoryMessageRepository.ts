import { conversationsMock, messagesMock } from '../mockData'
import type { Conversation, Message } from '../types'
import type { MessageRepository } from './MessageRepository'

type Listener = () => void

export class InMemoryMessageRepository implements MessageRepository {
  private conversations: Conversation[]
  private messages: Message[]
  private readonly listeners = new Set<Listener>()

  constructor(
    initialConversations: Conversation[] = [...conversationsMock],
    initialMessages: Message[] = [...messagesMock]
  ) {
    this.conversations = initialConversations
    this.messages = initialMessages
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  getLastError(): string | null {
    return null
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getConversations(): Conversation[] {
    return this.conversations
  }

  getConversationById(id: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === id)
  }

  getConversationByProjectId(id: string): Conversation | undefined {
    return this.conversations.find(
      (c) => c.projectId === id || c.sourceProjectId === id
    )
  }

  getMessages(): Message[] {
    return this.messages
  }

  getMessagesByConversationId(id: string): Message[] {
    return this.messages.filter((m) => m.conversationId === id)
  }

  addConversation(conversation: Conversation): Promise<void> {
    this.conversations = [...this.conversations, conversation]
    this.notify()
    return Promise.resolve()
  }

  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void {
    this.conversations = this.conversations.map((c) =>
      c.id === id ? { ...c, ...patch } : c
    )
    this.notify()
  }

  async addMessageAndUpdateConversation(
    message: Message,
    conversationId: string,
    conversationPatch: Partial<Omit<Conversation, 'id'>>
  ): Promise<void> {
    if (!this.conversations.some((c) => c.id === conversationId)) {
      throw new Error(`Unauthorized: conversation ${conversationId} not accessible`)
    }
    // Deduplicate: silently discard if a message with the same ID already exists.
    if (this.messages.some((m) => m.id === message.id)) return
    this.messages = [...this.messages, message]
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId ? { ...c, ...conversationPatch } : c
    )
    this.notify()
  }
}
