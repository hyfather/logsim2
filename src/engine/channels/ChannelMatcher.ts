/**
 * Converts a glob pattern to a RegExp
 * * matches any single segment (no dots)
 * ** matches multiple segments (including dots)
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern === '*') return /^.*$/

  const escaped = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^.]+')
    .replace(/__DOUBLE_STAR__/g, '.*')

  return new RegExp(`^${escaped}$`)
}

export function matchesChannel(channel: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true

  // Handle comma-separated patterns
  const patterns = pattern.split(',').map(p => p.trim()).filter(Boolean)
  return patterns.some(p => globToRegex(p).test(channel))
}

export function filterByChannel<T extends { channel: string }>(
  items: T[],
  pattern: string
): T[] {
  if (!pattern || pattern === '*') return items
  return items.filter(item => matchesChannel(item.channel, pattern))
}
