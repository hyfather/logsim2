'use client'
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { Trash2, X, RotateCcw } from 'lucide-react'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { BEHAVIOR_STATES, defaultsFor, fmtTime } from '@/lib/episodeBehavior'
import { getRegistryEntry } from '@/registry/nodeRegistry'
import { getNodeAddress } from '@/lib/network'
import type { BehaviorBlock, BehaviorState } from '@/types/episode'
import type { ConfigField, ScenarioNode } from '@/types/nodes'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const STATE_KEYS = Object.keys(BEHAVIOR_STATES) as BehaviorState[]

// Identity / structural fields the user shouldn't change per-beat. These are
// service-wide properties — runtime, port, log structure — that belong on the
// swimlane (service) panel, not on a behavior block. They render as compact,
// read-only rows inside the top "Service" section here.
const LOCKED_FIELD_KEYS = new Set([
  'port', 'framework', 'version',
  // Log structure / schema decisions — same shape across the whole episode.
  'logFormat', 'accessLogFormat', 'flowLogFormat',
  'logStatement', 'slowQueryLog', 'slowQueryThresholdMs',
])

function groupBySection(fields: ConfigField[]): Record<string, ConfigField[]> {
  const groups: Record<string, ConfigField[]> = {}
  for (const field of fields) {
    const section = field.section || 'General'
    if (!groups[section]) groups[section] = []
    groups[section].push(field)
  }
  return groups
}

function displayValue(field: ConfigField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (field.type === 'select') {
    const match = field.options?.find(o => o.value === String(value))
    return match?.label ?? String(value)
  }
  if (field.type === 'boolean') return value ? 'On' : 'Off'
  return String(value)
}

function FieldRenderer({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ConfigField
  value: unknown
  disabled?: boolean
  onChange: (val: unknown) => void
}) {
  const disabledClass = disabled ? 'cursor-not-allowed opacity-60' : ''
  switch (field.type) {
    case 'string':
      return (
        <Input
          value={String(value ?? '')}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          className={cn('h-7 text-xs', disabledClass)}
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          value={String(value ?? field.defaultValue ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className={cn('h-7 font-mono text-xs', disabledClass)}
        />
      )
    case 'boolean':
      return (
        <Switch
          checked={Boolean(value)}
          disabled={disabled}
          onCheckedChange={onChange}
          className={disabledClass}
        />
      )
    case 'select':
      return (
        <Select
          value={String(value ?? '')}
          disabled={disabled}
          onValueChange={onChange}
        >
          <SelectTrigger className={cn('h-7 text-xs', disabledClass)}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'slider': {
      const numVal = Number(value ?? field.defaultValue ?? 0)
      return (
        <div className={cn('flex items-center gap-2', disabledClass)}>
          <Slider
            value={[numVal]}
            min={field.min ?? 0}
            max={field.max ?? 100}
            step={field.step ?? 1}
            disabled={disabled}
            onValueChange={([v]) => onChange(v)}
            className="flex-1"
          />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-slate-500">
            {numVal.toFixed(field.step && field.step < 1 ? 2 : 0)}
          </span>
        </div>
      )
    }
    case 'code':
      return (
        <Textarea
          value={String(value ?? '')}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          className={cn('h-20 resize-none font-mono text-xs', disabledClass)}
        />
      )
    default:
      return (
        <Input
          value={String(value ?? '')}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className={cn('h-7 text-xs', disabledClass)}
        />
      )
  }
}

export function BlockInspector() {
  const selectedBlockId = useEpisodeStore(s => s.selectedBlockId)
  const episode = useEpisodeStore(s => s.episode)
  const setSelectedBlock = useEpisodeStore(s => s.setSelectedBlock)
  const updateBlock = useEpisodeStore(s => s.updateBlock)
  const deleteBlock = useEpisodeStore(s => s.deleteBlock)
  const nodes = useScenarioStore(s => s.nodes)
  const panelRef = useRef<HTMLDivElement>(null)

  const { block, nodeData } = useMemo(() => {
    if (!selectedBlockId) return { block: null as BehaviorBlock | null, nodeData: null as ScenarioNode | null }
    for (const [sid, blocks] of Object.entries(episode.lanes)) {
      const b = blocks.find(x => x.id === selectedBlockId)
      if (b) {
        const node = nodes.find(n => n.id === sid)
        return { block: b, nodeData: (node?.data as ScenarioNode | undefined) ?? null }
      }
    }
    return { block: null, nodeData: null }
  }, [selectedBlockId, episode.lanes, nodes])

  // Dismiss on outside click. Ignore clicks on timeline blocks/playhead so
  // re-selecting another block works, and ignore Radix popovers (selects).
  useEffect(() => {
    if (!selectedBlockId) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (target.closest('[data-block]')) return
      if (target.closest('[data-radix-popper-content-wrapper]')) return
      setSelectedBlock(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [selectedBlockId, setSelectedBlock])

  const setOverride = useCallback((key: string, value: unknown) => {
    if (!block) return
    const next = { ...(block.configOverrides ?? {}) }
    next[key] = value
    updateBlock(block.id, { configOverrides: next })
  }, [block, updateBlock])

  const clearOverride = useCallback((key: string) => {
    if (!block) return
    const next = { ...(block.configOverrides ?? {}) }
    delete next[key]
    updateBlock(block.id, { configOverrides: Object.keys(next).length === 0 ? undefined : next })
  }, [block, updateBlock])

  if (!block || !nodeData) return null
  const meta = BEHAVIOR_STATES[block.state]

  const configSchema: ConfigField[] = getRegistryEntry(nodeData.type, nodeData.serviceType)?.configSchema || []
  const baselineConfig = (nodeData.config as Record<string, unknown>) || {}
  const overrides = block.configOverrides ?? {}
  // Locked, service-wide fields render once at the top under "Service".
  // Per-beat editable fields render in their schema sections below.
  const lockedFields = configSchema.filter(f => LOCKED_FIELD_KEYS.has(f.key))
  const sections = groupBySection(configSchema.filter(f => !LOCKED_FIELD_KEYS.has(f.key)))

  const allNodes = nodes.map(n => n.data as ScenarioNode)
  const address = getNodeAddress(nodeData, allNodes)
  const addressValue = nodeData.privateIp?.trim() || address

  const onChangeState = (state: BehaviorState) => {
    updateBlock(block.id, { state, ...defaultsFor(state) })
  }

  const endTick = block.start + block.duration

  return (
    <div ref={panelRef} className="flex h-full flex-col overflow-hidden bg-white">
      {/* Header — eyebrow makes this clearly a Behavior Block panel */}
      <div className="flex shrink-0 items-start gap-2 border-b border-slate-200 px-3 py-2">
        <span className="mt-0.5 text-[14px] leading-none" style={{ color: meta.color }}>{meta.glyph}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-400">Behavior block</div>
          <div className="truncate text-[13px] font-semibold leading-tight text-slate-900">
            {meta.label}
            <span className="ml-1.5 text-[11px] font-normal text-slate-500">on {nodeData.label}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSelectedBlock(null)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          title="Close inspector"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* State + timing — collapsed into one compact section */}
        <section className="flex flex-col gap-2 border-b border-slate-200 px-3 py-2.5">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">Behavior</div>
            <div className="text-[9.5px] text-slate-400">overrides while active</div>
          </div>
          <Select value={block.state} onValueChange={(v) => onChangeState(v as BehaviorState)}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATE_KEYS.map(s => {
                const m = BEHAVIOR_STATES[s]
                return (
                  <SelectItem key={s} value={s} className="text-xs">
                    <span className="inline-flex items-center gap-2">
                      <span style={{ color: m.color }}>{m.glyph}</span>
                      <span>{m.label}</span>
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="flex items-baseline justify-between text-[10.5px] font-medium text-slate-500">
                <span>Start</span>
                <span className="font-mono text-[9.5px] text-slate-400">{fmtTime(block.start)}</span>
              </label>
              <Input
                type="number"
                min={0}
                max={Math.max(0, episode.duration - 5)}
                value={block.start}
                onChange={e => {
                  const v = Math.max(0, Math.min(episode.duration - 5, parseInt(e.target.value) || 0))
                  updateBlock(block.id, { start: v })
                }}
                className="h-7 font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-baseline justify-between text-[10.5px] font-medium text-slate-500">
                <span>Duration</span>
                <span className="font-mono text-[9.5px] text-slate-400">{fmtTime(block.duration)}</span>
              </label>
              <Input
                type="number"
                min={5}
                max={episode.duration}
                value={block.duration}
                onChange={e => {
                  const v = Math.max(5, Math.min(episode.duration - block.start, parseInt(e.target.value) || 5))
                  updateBlock(block.id, { duration: v })
                }}
                className="h-7 font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex items-center justify-between text-[10.5px] text-slate-500">
            <span>Ends at</span>
            <span className="font-mono text-slate-700">{fmtTime(Math.min(endTick, episode.duration))}</span>
          </div>
        </section>

        {/* Service (locked) — service-wide identity + structural fields. Edit
            these on the swimlane panel; here they're read-only. */}
        <section className="flex flex-col gap-1 border-b border-slate-200 px-3 py-2">
          <div className="mb-0.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            <span>Service</span>
            <span className="text-[9px] font-semibold tracking-wider text-slate-400">Locked</span>
          </div>
          <div className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
            <span className="text-slate-500">Address</span>
            <span className="truncate font-mono text-slate-700">{addressValue}</span>
          </div>
          {nodeData.channel && (
            <div className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
              <span className="text-slate-500">Channel</span>
              <span className="truncate font-mono text-slate-700">{nodeData.channel}</span>
            </div>
          )}
          {lockedFields.map(field => (
            <div key={field.key} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
              <span className="text-slate-500">{field.label}</span>
              <span className="truncate font-mono text-slate-700">
                {displayValue(field, baselineConfig[field.key] ?? field.defaultValue)}
              </span>
            </div>
          ))}
        </section>

        {/* Per-beat editable fields, grouped by their schema section. */}
        {Object.entries(sections).map(([section, fields]) => (
          <section key={section} className="flex flex-col gap-2 border-b border-slate-200 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{section}</div>
            {fields.map(field => {
              const isErrorRate = field.key === 'errorRate'
              const baselineValue = baselineConfig[field.key] ?? field.defaultValue
              const hasOverride = isErrorRate
                ? block.errorRate !== baselineValue
                : Object.prototype.hasOwnProperty.call(overrides, field.key)
              const effectiveValue = isErrorRate
                ? block.errorRate
                : (hasOverride ? overrides[field.key] : baselineValue)

              const handleChange = (val: unknown) => {
                if (isErrorRate) {
                  updateBlock(block.id, { errorRate: Number(val) })
                  return
                }
                setOverride(field.key, val)
              }

              const handleReset = () => {
                if (isErrorRate) {
                  updateBlock(block.id, { errorRate: Number(baselineValue ?? 0) })
                  return
                }
                clearOverride(field.key)
              }

              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="flex items-center justify-between text-[10.5px] font-medium text-slate-500">
                    <span>{field.label}</span>
                    {hasOverride && (
                      <span className="flex items-center gap-1.5">
                        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-blue-600">Override</span>
                        <button
                          type="button"
                          onClick={handleReset}
                          title="Reset to baseline"
                          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </label>
                  <FieldRenderer
                    field={field}
                    value={effectiveValue}
                    onChange={handleChange}
                  />
                  {field.description && (
                    <p className="text-[10px] text-slate-500">{field.description}</p>
                  )}
                </div>
              )
            })}
          </section>
        ))}

        {/* Custom log */}
        <section className="flex flex-col gap-1.5 border-b border-slate-200 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">Custom log</div>
          <Textarea
            placeholder="e.g. ECONNRESET upstream"
            value={block.customLog || ''}
            onChange={e => updateBlock(block.id, { customLog: e.target.value })}
            className="h-14 resize-none font-mono text-xs"
          />
          <p className="text-[9.5px] text-slate-400">Overrides the state&rsquo;s log templates while this block is active.</p>
        </section>

        {/* Designer note */}
        <section className="flex flex-col gap-1.5 border-b border-slate-200 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">Designer note</div>
          <Textarea
            placeholder="Why this block exists"
            value={block.note || ''}
            onChange={e => updateBlock(block.id, { note: e.target.value })}
            className="h-12 resize-none text-xs"
          />
        </section>
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-2">
        <button
          type="button"
          onClick={() => deleteBlock(block.id)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete block
        </button>
      </div>
    </div>
  )
}
