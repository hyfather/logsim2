import Link from 'next/link'
import { promises as fs } from 'fs'
import path from 'path'
import { Sparkles, ArrowRight, Clock, Layers, ShieldAlert, Activity, Rocket, Heart } from 'lucide-react'

interface PresetEntry {
  file: string
  title: string
  description: string
  category: 'incident' | 'security' | 'deploy' | 'baseline' | string
  difficulty: 'easy' | 'medium' | 'hard' | string
  durationTicks: number
  serviceCount: number
}

async function loadPresets(): Promise<PresetEntry[]> {
  try {
    const file = path.join(process.cwd(), 'public', 'scenarios', 'presets', 'index.json')
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as PresetEntry[]
  } catch {
    return []
  }
}

const CATEGORY_META: Record<string, { label: string; tint: string; ring: string; Icon: typeof ShieldAlert }> = {
  incident: { label: 'Incident', tint: 'bg-amber-50 text-amber-800', ring: 'ring-amber-200', Icon: Activity },
  security: { label: 'Security', tint: 'bg-rose-50 text-rose-800', ring: 'ring-rose-200', Icon: ShieldAlert },
  deploy: { label: 'Deploy', tint: 'bg-violet-50 text-violet-800', ring: 'ring-violet-200', Icon: Rocket },
  baseline: { label: 'Baseline', tint: 'bg-emerald-50 text-emerald-800', ring: 'ring-emerald-200', Icon: Heart },
}

const DIFFICULTY_TINT: Record<string, string> = {
  easy: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  hard: 'bg-rose-100 text-rose-700',
}

function fmtDuration(ticks: number) {
  const m = Math.round(ticks / 60)
  return `${m} min`
}

function presetSlug(file: string) {
  return file.replace(/\.scenario\.json$/, '')
}

export default async function LandingPage() {
  const presets = await loadPresets()

  return (
    <main className="min-h-[100dvh] bg-gradient-to-b from-slate-50 via-white to-slate-50">
      <header className="mx-auto max-w-6xl px-6 pt-12 pb-8 sm:pt-16 sm:px-8">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <span className="inline-block size-2 rounded-full bg-emerald-500" />
          logsim
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Pick a scenario, watch the logs unfold.
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-slate-600">
          Each scenario is a small, self-contained story — a network of services, a timeline of state changes,
          and the realistic logs that fall out of it. Open one to explore, or describe your own and let AI generate it.
        </p>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-16 sm:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <BuildYourOwnTile />
          {presets.map(p => <ScenarioTile key={p.file} preset={p} />)}
        </div>

        <div className="mt-10 flex items-center justify-center gap-2 text-[13px] text-slate-500">
          <span>Or</span>
          <Link
            href="/editor"
            className="font-medium text-slate-700 underline decoration-dotted underline-offset-4 hover:text-slate-900"
          >
            start with a blank canvas
          </Link>
        </div>
      </section>
    </main>
  )
}

function ScenarioTile({ preset }: { preset: PresetEntry }) {
  const cat = CATEGORY_META[preset.category] ?? {
    label: preset.category, tint: 'bg-slate-100 text-slate-700', ring: 'ring-slate-200', Icon: Layers,
  }
  const diff = DIFFICULTY_TINT[preset.difficulty] ?? 'bg-slate-100 text-slate-700'
  const Icon = cat.Icon

  return (
    <Link
      href={`/editor?scenario=${presetSlug(preset.file)}`}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-transparent transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${cat.tint}`}>
          <Icon className="size-3" />
          {cat.label}
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider ${diff}`}>
          {preset.difficulty}
        </span>
      </div>

      <h3 className="mt-3 text-[16px] font-semibold leading-snug text-slate-900 group-hover:text-slate-950">
        {preset.title}
      </h3>
      <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-slate-600">
        {preset.description}
      </p>

      <div className="mt-4 flex items-center gap-3 text-[11px] font-mono text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" />
          {fmtDuration(preset.durationTicks)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Layers className="size-3" />
          {preset.serviceCount} services
        </span>
      </div>

      <div className="mt-4 inline-flex items-center gap-1 text-[12px] font-semibold text-slate-700 opacity-70 transition-opacity group-hover:opacity-100">
        Open scenario
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  )
}

function BuildYourOwnTile() {
  return (
    <Link
      href="/editor?ai=1"
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
    >
      <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-indigo-400/10 blur-2xl" />
      <div className="pointer-events-none absolute -left-6 -bottom-6 size-24 rounded-full bg-violet-400/10 blur-2xl" />

      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-indigo-600/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700">
        <Sparkles className="size-3" />
        AI-assisted
      </div>

      <h3 className="mt-3 text-[16px] font-semibold leading-snug text-slate-900">
        Build your own scenario
      </h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
        Describe the system and the failure mode in plain English. We&apos;ll generate the topology, the timeline,
        and the logs — then you can refine it on the canvas.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5 text-[10.5px] font-mono text-indigo-700/80">
        <Pill>&ldquo;auth-api gets brute-forced&rdquo;</Pill>
        <Pill>&ldquo;cache OOM cascades&rdquo;</Pill>
        <Pill>&ldquo;db replica lag&rdquo;</Pill>
      </div>

      <div className="mt-4 inline-flex items-center gap-1 text-[12px] font-semibold text-indigo-700">
        Describe & generate
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-indigo-200/70 bg-white/70 px-2 py-0.5">
      {children}
    </span>
  )
}
