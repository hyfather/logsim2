import type { BehaviorBlock, BehaviorState, Episode } from '@/types/episode'
import { generateId } from '@/lib/id'

export interface BehaviorStateMeta {
  label: string
  color: string
  text: string
  bg: string
  glyph: string
}

export const BEHAVIOR_STATES: Record<BehaviorState, BehaviorStateMeta> = {
  healthy:      { label: 'Healthy',      color: '#86efac', text: '#166534', bg: '#f0fdf4', glyph: '●' },
  degraded:     { label: 'Degraded',     color: '#fcd34d', text: '#854d0e', bg: '#fffbeb', glyph: '◐' },
  down:         { label: 'Down',         color: '#dc2626', text: '#991b1b', bg: '#fef2f2', glyph: '✕' },
  recovering:   { label: 'Recovering',   color: '#93c5fd', text: '#1e40af', bg: '#eff6ff', glyph: '↻' },
  under_attack: { label: 'Under attack', color: '#fb923c', text: '#9a3412', bg: '#fff7ed', glyph: '⚡' },
  throttled:    { label: 'Throttled',    color: '#a78bfa', text: '#5b21b6', bg: '#f5f3ff', glyph: '▤' },
  compromised:  { label: 'Compromised',  color: '#be185d', text: '#831843', bg: '#fdf2f8', glyph: '⚑' },
}

const DEFAULTS: Record<BehaviorState, Pick<BehaviorBlock, 'errorRate' | 'latencyMul' | 'logVolMul'>> = {
  healthy:      { errorRate: 0.005, latencyMul: 1.0, logVolMul: 1.0 },
  degraded:     { errorRate: 0.05,  latencyMul: 2.0, logVolMul: 1.4 },
  down:         { errorRate: 0.85,  latencyMul: 6.0, logVolMul: 0.5 },
  recovering:   { errorRate: 0.02,  latencyMul: 1.4, logVolMul: 1.2 },
  under_attack: { errorRate: 0.25,  latencyMul: 3.0, logVolMul: 4.0 },
  throttled:    { errorRate: 0.10,  latencyMul: 2.5, logVolMul: 0.7 },
  compromised:  { errorRate: 0.02,  latencyMul: 1.0, logVolMul: 1.5 },
}

export function makeBlock(
  state: BehaviorState,
  start: number,
  duration: number,
  opts: Partial<BehaviorBlock> = {},
): BehaviorBlock {
  return {
    id: generateId(),
    start,
    duration,
    state,
    ...DEFAULTS[state],
    ...opts,
  }
}

export function defaultsFor(state: BehaviorState) {
  return DEFAULTS[state]
}

export function blockAt(episode: Episode, serviceId: string, tick: number): BehaviorBlock | undefined {
  const blocks = episode.lanes[serviceId] ?? []
  return blocks.find(b => tick >= b.start && tick < b.start + b.duration)
}

export function stateAt(episode: Episode, serviceId: string, tick: number): BehaviorState {
  return blockAt(episode, serviceId, tick)?.state ?? 'healthy'
}

export function intensityAt(episode: Episode, tick: number): number {
  let max = 0
  for (const sid of Object.keys(episode.lanes)) {
    const b = blockAt(episode, sid, tick)
    if (!b) continue
    const v = b.errorRate + Math.max(0, (b.logVolMul - 1) * 0.2)
    if (v > max) max = v
  }
  return Math.min(1, max)
}

export function fmtTime(ticks: number): string {
  const m = Math.floor(ticks / 60)
  const s = Math.round(ticks % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
