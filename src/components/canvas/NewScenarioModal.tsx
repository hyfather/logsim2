'use client'
import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Activity,
  Clock,
  Cloud,
  FilePlus2,
  Heart,
  Layers,
  Rocket,
  ShieldAlert,
  UserCog,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useScenarioStore } from '@/store/useScenarioStore'
import { useEpisodeStore } from '@/store/useEpisodeStore'
import { useScenarioLibraryStore } from '@/store/useScenarioLibraryStore'
import { materializeProposedScenarioJson } from '@/lib/scenarioPrompt'
import { cn } from '@/lib/utils'

interface PresetEntry {
  file: string
  title: string
  description: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard' | string
  durationTicks: number
  serviceCount: number
}

interface PresetGroup {
  id: string
  label: string
  description?: string
  order?: number
}

const FALLBACK_GROUPS: PresetGroup[] = [
  { id: 'incident', label: 'Production Incidents', order: 1 },
  { id: 'deploy',   label: 'Deploys & Releases',  order: 2 },
  { id: 'security', label: 'External Threats',    order: 3 },
  { id: 'insider',  label: 'Insider & Abuse',     order: 4 },
  { id: 'cloud',    label: 'Cloud & Identity',    order: 5 },
  { id: 'baseline', label: 'Baselines',           order: 6 },
]

const CATEGORY_META: Record<string, { label: string; tint: string; Icon: typeof ShieldAlert }> = {
  incident: { label: 'Incident', tint: 'bg-amber-50 text-amber-800',     Icon: Activity },
  security: { label: 'Security', tint: 'bg-rose-50 text-rose-800',       Icon: ShieldAlert },
  deploy:   { label: 'Deploy',   tint: 'bg-violet-50 text-violet-800',   Icon: Rocket },
  insider:  { label: 'Insider',  tint: 'bg-emerald-50 text-emerald-800', Icon: UserCog },
  cloud:    { label: 'Cloud',    tint: 'bg-sky-50 text-sky-800',         Icon: Cloud },
  baseline: { label: 'Baseline', tint: 'bg-slate-100 text-slate-700',    Icon: Heart },
}

const DIFFICULTY_TINT: Record<string, string> = {
  easy:   'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  hard:   'bg-rose-100 text-rose-700',
}

interface NewScenarioModalProps {
  open: boolean
  onClose: () => void
}

export function NewScenarioModal({ open, onClose }: NewScenarioModalProps) {
  const [presets, setPresets] = useState<PresetEntry[]>([])
  const [groups, setGroups] = useState<PresetGroup[]>(FALLBACK_GROUPS)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadScenario = useScenarioStore(s => s.loadScenario)
  const resetScenario = useScenarioStore(s => s.resetScenario)
  const setEpisode = useEpisodeStore(s => s.setEpisode)

  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/scenarios/presets/index.json', { cache: 'no-cache' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        if (Array.isArray(json)) {
          setPresets(json)
        } else if (json && Array.isArray(json.scenarios)) {
          setPresets(json.scenarios)
          if (Array.isArray(json.groups) && json.groups.length > 0) {
            setGroups(json.groups)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [open, loaded])

  const grouped = useMemo(() => {
    const buckets = new Map<string, PresetEntry[]>()
    for (const p of presets) {
      const list = buckets.get(p.category) ?? []
      list.push(p)
      buckets.set(p.category, list)
    }
    const known = groups
      .map(g => ({ group: g, items: buckets.get(g.id) ?? [] }))
      .filter(b => b.items.length > 0)
    const knownIds = new Set(groups.map(g => g.id))
    const unknownIds = Array.from(buckets.keys()).filter(id => !knownIds.has(id))
    const unknown = unknownIds.map(id => ({
      group: { id, label: id.charAt(0).toUpperCase() + id.slice(1) } as PresetGroup,
      items: buckets.get(id) ?? [],
    }))
    return [...known, ...unknown]
  }, [presets, groups])

  const handleBlank = () => {
    useScenarioLibraryStore.getState().startNew()
    resetScenario()
    useEpisodeStore.getState().resetEpisode()
    onClose()
  }

  const handleTemplate = async (preset: PresetEntry) => {
    try {
      const res = await fetch(`/scenarios/presets/${preset.file}`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const result = materializeProposedScenarioJson(json)
      const now = new Date().toISOString()
      useScenarioLibraryStore.getState().startNew()
      loadScenario(result.flowNodes, result.flowEdges, {
        name: result.name?.trim() || preset.title,
        description: result.description?.trim() || preset.description,
        createdAt: now,
        updatedAt: now,
      })
      if (result.episode) setEpisode(result.episode)
      window.dispatchEvent(new CustomEvent('logsim-autosave'))
    } catch (err) {
      alert('Failed to load template: ' + String(err))
    } finally {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex h-[min(720px,90dvh)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-6 py-4">
          <DialogTitle className="text-base font-semibold text-slate-900">New scenario</DialogTitle>
          <DialogDescription className="text-[12px] text-slate-500">
            Start from a blank canvas, or pick a template — a small self-contained story with services, a timeline, and the logs that fall out of it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <BlankTile onClick={handleBlank} />
            {!loaded && presets.length === 0 ? (
              <div className="col-span-full px-2 py-8 text-center text-[12px] text-slate-400">
                Loading templates…
              </div>
            ) : null}
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
              Failed to load templates: {error}
            </div>
          )}

          {grouped.map(({ group, items }) => (
            <section key={group.id} className="mt-7 first:mt-7">
              <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {group.label}
                <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
                  {items.length}
                </span>
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map(p => (
                  <TemplateTile key={p.file} preset={p} onClick={() => handleTemplate(p)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BlankTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
    >
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
        <FilePlus2 className="h-3 w-3" />
        Blank
      </div>
      <h3 className="mt-2.5 text-[14px] font-semibold leading-snug text-slate-900">
        Blank canvas
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
        Start with an empty diagram. Drag services onto the canvas and wire them up by hand.
      </p>
      <div className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-semibold text-slate-700 opacity-70 transition-opacity group-hover:opacity-100">
        Open blank canvas
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  )
}

function TemplateTile({ preset, onClick }: { preset: PresetEntry; onClick: () => void }) {
  const cat = CATEGORY_META[preset.category] ?? {
    label: preset.category,
    tint: 'bg-slate-100 text-slate-700',
    Icon: Layers,
  }
  const diff = DIFFICULTY_TINT[preset.difficulty] ?? 'bg-slate-100 text-slate-700'
  const Icon = cat.Icon
  const minutes = Math.round(preset.durationTicks / 60)

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          cat.tint,
        )}>
          <Icon className="h-3 w-3" />
          {cat.label}
        </div>
        <span className={cn(
          'rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider',
          diff,
        )}>
          {preset.difficulty}
        </span>
      </div>
      <h3 className="mt-2.5 text-[14px] font-semibold leading-snug text-slate-900">
        {preset.title}
      </h3>
      <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-slate-600">
        {preset.description}
      </p>
      <div className="mt-3 flex items-center gap-3 font-mono text-[10.5px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {minutes} min
        </span>
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3" />
          {preset.serviceCount} services
        </span>
      </div>
    </button>
  )
}
