import { generateUUID, isValidUUID } from '../shared/generateUUID'

export function generateProjectId(): string {
  return generateUUID()
}

export function isValidProjectId(id: string): boolean {
  return isValidUUID(id)
}
