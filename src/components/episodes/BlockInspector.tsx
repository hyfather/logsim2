'use client'
import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioStore } from '@/store/useScenarioStore'
import { BEHAVIOR_STATES, defaultsFor } from '@/lib/episodeBehavior'
import type { BehaviorBlock, BehaviorState } from '@/types/episode'

export function BlockInspector() {
  const selectedBlockId = useEpisodeStore(s => s.selectedBlockId)
  const episode = useEpisodeStore(s => s.episode)
  const setSelectedBlock = useEpisodeStore(s => s.setSelectedBlock)
  const updateBlock = useEpisodeStore(s => s.updateBlock)
  const deleteBlock = useEpisodeStore(s => s.deleteBlock)
  const nodes = useScenarioStore(s => s.nodes)

  const { block, serviceLabel } = useMemo(() => {
    if (!selectedBlockId) return { block: null as BehaviorBlock | null, serviceLabel: '' }
    for (const [sid, blocks] of Object.entries(episode.lanes)) {
      const b = blocks.find(x => x.id === selectedBlockId)
      if (b) {
        const node = nodes.find(n => n.id === sid)
        return { block: b, serviceLabel: (node?.data.label as string) || sid }
      }
    }
    return { block: null, serviceLabel: '' }
  }, [selectedBlockId, episode.lanes, nodes])

  if (!block) return null
  const meta = BEHAVIOR_STATES[block.state]
  const states = Object.keys(BEHAVIOR_STATES) as BehaviorState[]

  const onChangeState = (state: BehaviorState) => {
    // Re-apply the state's defaults so sliders reflect the new template,
    // but preserve any explicit customLog/note the user already set.
    updateBlock(block.id, { state, ...defaultsFor(state) })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-base leading-none" style={{ color: meta.color }}>{meta.glyph}</span>
          <strong className="truncate text-sm">{meta.label}</strong>
          <span className="truncate text-[11px] text-slate-500">on {serviceLabel}</span>
        </div>
        <button
          onClick={() => setSelectedBlock(null)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Close inspector"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">State</span>
            <select
              value={block.state}
              onChange={e => onChangeState(e.target.value as BehaviorState)}
              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs"
            >
              {states.map(s => (
                <option key={s} value={s}>{BEHAVIOR_STATES[s].label}</option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Start</span>
              <Input
                type="number"
                min={0}
                value={block.start}
                onChange={e => updateBlock(block.id, { start: Math.max(0, parseInt(e.target.value) || 0) })}
                className="mt-1 h-8 text-xs"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Duration</span>
              <Input
                type="number"
                min={5}
                value={block.duration}
                onChange={e => updateBlock(block.id, { duration: Math.max(5, parseInt(e.target.value) || 5) })}
                className="mt-1 h-8 text-xs"
              />
            </label>
          </div>

          <SliderField
            label="Error rate"
            value={block.errorRate}
            display={`${(block.errorRate * 100).toFixed(1)}%`}
            min={0} max={1} step={0.01}
            onChange={v => updateBlock(block.id, { errorRate: v })}
          />
          <SliderField
            label="Latency multiplier"
            value={block.latencyMul}
            display={`${block.latencyMul.toFixed(1)}×`}
            min={0.5} max={10} step={0.1}
            onChange={v => updateBlock(block.id, { latencyMul: v })}
          />
          <SliderField
            label="Log volume"
            value={block.logVolMul}
            display={`${block.logVolMul.toFixed(1)}×`}
            min={0.1} max={6} step={0.1}
            onChange={v => updateBlock(block.id, { logVolMul: v })}
          />

          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Custom log (overrides templates)</span>
            <textarea
              rows={2}
              placeholder="e.g. ECONNRESET upstream"
              value={block.customLog || ''}
              onChange={e => updateBlock(block.id, { customLog: e.target.value })}
              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11px]"
            />
          </label>

          <label className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Designer note</span>
            <textarea
              rows={2}
              placeholder="Why this block exists"
              value={block.note || ''}
              onChange={e => updateBlock(block.id, { note: e.target.value })}
              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]"
            />
          </label>
        </div>
      </div>

      <div className="border-t border-slate-200 px-3 py-2">
        <Button
          variant="destructive"
          size="sm"
          className="h-8 w-full text-xs"
          onClick={() => deleteBlock(block.id)}
        >
          Delete block
        </Button>
      </div>
    </div>
  )
}

function SliderField({ label, value, display, min, max, step, onChange }: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        <span>{label}</span>
        <em className="not-italic font-mono text-[11px] text-slate-700">{display}</em>
      </span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full"
      />
    </label>
  )
}
