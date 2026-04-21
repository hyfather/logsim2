export type TrafficPattern = 'steady' | 'bursty' | 'diurnal' | 'incident'

/**
 * Get traffic multiplier based on pattern and tick context
 */
export function getTrafficMultiplier(
  pattern: TrafficPattern,
  tickIndex: number,
  rng: () => number
): number {
  switch (pattern) {
    case 'steady':
      return 1 + (rng() - 0.5) * 0.2 // ±10% noise

    case 'bursty': {
      // Every ~20 ticks, a burst lasting 3-5 ticks
      const burstPeriod = 20
      const inBurst = (tickIndex % burstPeriod) < 5
      return inBurst ? 3 + rng() * 4 : 0.3 + rng() * 0.4
    }

    case 'diurnal': {
      // Simulate time-of-day: peak at hour 9-17 (assuming 1 tick = 1 second)
      const secondsInDay = 86400
      const secondOfDay = tickIndex % secondsInDay
      const hourOfDay = secondOfDay / 3600
      // Gaussian-ish peak at midday
      const peakHour = 13
      const spread = 4
      const base = Math.exp(-0.5 * Math.pow((hourOfDay - peakHour) / spread, 2))
      const noise = 1 + (rng() - 0.5) * 0.1
      return 0.1 + base * 0.9 * noise
    }

    case 'incident': {
      // Phases: normal (0-30%), spike (30-50%), errors (50-80%), recovery (80-100%)
      const phase = (tickIndex % 100) / 100
      if (phase < 0.3) return 1 + (rng() - 0.5) * 0.2
      if (phase < 0.5) return 3 + rng() * 5
      if (phase < 0.8) return 2 + rng() * 2
      return 0.5 + (phase - 0.8) / 0.2 * 0.5
    }

    default:
      return 1
  }
}
