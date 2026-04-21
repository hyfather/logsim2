let counter = 0

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${counter++}`
}

export function generateShortId(): string {
  return Math.random().toString(36).substr(2, 8)
}
