import { teamMembersMock } from '../../jobs/mockData'
import type { TeamMember } from '../../jobs/types'
import type { TeamMemberRepository } from './TeamMemberRepository'

type Listener = () => void

export class InMemoryTeamMemberRepository implements TeamMemberRepository {
  private members: TeamMember[] = [...teamMembersMock]
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time.
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): TeamMember[] {
    return [...this.members]
  }

  getById(id: string): TeamMember | undefined {
    return this.members.find((m) => m.id === id)
  }

  getByUserId(userId: string): TeamMember | undefined {
    return this.members.find((m) => m.userId === userId)
  }

  add(member: TeamMember): void {
    this.members = [...this.members, member]
    this.notify()
  }

  update(memberId: string, updater: (m: TeamMember) => TeamMember): void {
    this.members = this.members.map((m) => (m.id === memberId ? updater(m) : m))
    this.notify()
  }

  reset(): void {
    this.members = [...teamMembersMock]
    this.notify()
  }
}
