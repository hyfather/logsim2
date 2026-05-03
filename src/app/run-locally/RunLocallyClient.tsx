'use client'
import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Search,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScenarioEntry, ScenarioIndex } from './scenarios'

const REPO_SLUG = 'hyfather/logsim2'
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/master/scripts/install.sh`
const RELEASES_URL = `https://github.com/${REPO_SLUG}/releases`
const FALLBACK_ORIGIN = 'https://logsim.app'

interface Props {
  index: ScenarioIndex
}

export default function RunLocallyClient({ index }: Props) {
  const [origin, setOrigin] = useState(FALLBACK_ORIGIN)
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      setOrigin(window.location.origin)
    }
  }, [])

  const groupLabels = useMemo(() => {
    const out = new Map<string, string>()
    for (const g of index.groups) out.set(g.id, g.label)
    return out
  }, [index.groups])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return index.scenarios.filter(s => {
      if (activeCategory !== 'all' && s.category !== activeCategory) return false
      if (!q) return true
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q)
      )
    })
  }, [index.scenarios, query, activeCategory])

  const featuredSlug = 'db-slowdown-cascade'
  const featured =
    index.scenarios.find(s => s.slug === featuredSlug) ?? index.scenarios[0]

  const installCmd = `curl -fsSL ${INSTALL_URL} | sh`
  const fromSourceCmd = `go install github.com/${REPO_SLUG}/cmd/logsim@latest`
  const verifyCmd = `logsim --help`
  const featuredUrl = featured ? `${origin}/s/${featured.slug}.yaml` : ''
  const featuredCmd = featured ? `logsim run ${featuredUrl}` : ''
  const featuredOcsf = featured
    ? `logsim run ${featuredUrl} --ocsf -o ${featured.slug}.ocsf.json`
    : ''
  const featuredCribl = featured
    ? `logsim run ${featuredUrl} --to prod-cribl`
    : ''

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link
            href="/editor"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to editor
          </Link>
          <div className="flex items-center gap-2">
            <a
              href={`https://github.com/${REPO_SLUG}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50"
            >
              <Download className="h-3 w-3" />
              Releases
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        {/* Hero */}
        <section className="mb-10">
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-blue-700">
            <Terminal className="h-3 w-3" />
            CLI
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-slate-900 sm:text-4xl">
            Run LogSim on your laptop.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600">
            Install the <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px]">logsim</code> binary,
            then run any built-in scenario by URL — no Vercel, no browser, no copy-paste. Same engine
            that powers the editor canvas, just streaming straight to your terminal, a file, or your SIEM.
          </p>
        </section>

        {/* Step 1 — Install */}
        <Step number={1} title="Install the CLI">
          <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
            The installer drops a single static binary into{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">~/.local/bin</code>{' '}
            (or <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">/usr/local/bin</code> if writable),
            verifies a SHA-256 checksum, and prints the line you need to add to your PATH if it isn&apos;t there already.
          </p>
          <CommandBlock label="macOS / Linux" command={installCmd} />
          <CommandBlock
            label="From source (any platform with Go 1.25+)"
            command={fromSourceCmd}
          />
          <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
            Pre-built binaries for darwin/linux on amd64 + arm64 are on{' '}
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 font-medium text-blue-600 hover:underline"
            >
              GitHub Releases <ExternalLink className="h-2.5 w-2.5" />
            </a>{' '}
            with checksums. Windows users — use{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">go install</code>.
          </p>
        </Step>

        {/* Step 2 — Verify */}
        <Step number={2} title="Verify it&rsquo;s on your PATH">
          <CommandBlock
            label="Sanity check"
            command={verifyCmd}
            hint="Prints the top-level help — `run`, `validate`, `serve`, `destinations`."
          />
        </Step>

        {/* Step 3 — Run from a URL */}
        <Step number={3} title="Run any default scenario by URL">
          <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
            Every built-in scenario lives at a short URL pair:{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">{origin}/s/&lt;slug&gt;</code>{' '}
            opens it in the canvas editor,{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">{origin}/s/&lt;slug&gt;.yaml</code>{' '}
            is the runnable YAML. Hand the YAML URL to{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">logsim run</code> and it&rsquo;ll fetch,
            parse, and stream — no <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px]">git clone</code> needed.
          </p>
          {featured && (
            <>
              <CommandBlock
                label={`Quick demo — ${featured.title}`}
                command={featuredCmd}
                hint="Fetches the YAML over HTTPS, runs the scenario, prints JSONL to stdout. Ctrl-C to stop."
              />
              <CommandBlock
                label="As OCSF events into a file"
                command={featuredOcsf}
                hint="`-o` writes to a file; the .ocsf.json suffix auto-selects --format=ocsf."
              />
              <CommandBlock
                label="Forward to a configured destination"
                command={featuredCribl}
                hint="Configure once with `logsim destinations add`, then `--to <name>` (or `--to all`)."
              />
            </>
          )}
        </Step>

        {/* Browse all scenarios */}
        <section className="mt-12">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-[-0.01em] text-slate-900">
                <Globe className="h-4 w-4 text-slate-400" />
                Browse the {index.scenarios.length} default scenarios
              </h2>
              <p className="mt-1 text-[13px] text-slate-500">
                Each one is a self-contained YAML — copy the command, paste, run.
              </p>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Filter scenarios…"
                className="w-64 rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>

          {/* Category tabs */}
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <CategoryTab
              label={`All ${index.scenarios.length}`}
              active={activeCategory === 'all'}
              onClick={() => setActiveCategory('all')}
            />
            {index.groups.map(group => {
              const count = index.scenarios.filter(s => s.category === group.id).length
              if (count === 0) return null
              return (
                <CategoryTab
                  key={group.id}
                  label={`${group.label} · ${count}`}
                  active={activeCategory === group.id}
                  onClick={() => setActiveCategory(group.id)}
                />
              )
            })}
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-10 text-center text-[13px] text-slate-500">
              No scenarios match that filter.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
              {filtered.map(s => (
                <ScenarioRow
                  key={s.slug}
                  scenario={s}
                  origin={origin}
                  groupLabel={groupLabels.get(s.category) ?? s.category}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Tips */}
        <section className="mt-12 grid gap-4 sm:grid-cols-2">
          <TipCard
            title="Pipe into anything"
            body={
              <>
                stdout is the silent default — pipe straight into{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">jq</code>,{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">vector</code>,{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">fluent-bit</code>,
                or <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">jq -c &apos;{`select(.level=="ERROR")`}&apos;</code>.
              </>
            }
          />
          <TipCard
            title="Pick a wire schema"
            body={
              <>
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">--ocsf</code>,{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">--otel</code>, or{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">--format jsonl</code>.
                Output paths ending in <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">.ocsf.json</code>{' '}
                or <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">.otel.json</code> auto-infer the format.
              </>
            }
          />
          <TipCard
            title="Forward to your SIEM"
            body={
              <>
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">logsim destinations add</code>{' '}
                walks you through Cribl Stream / Splunk HEC. Then{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">--to &lt;name&gt;</code>{' '}
                (or <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px]">--to all</code>) layers in forwarding.
              </>
            }
          />
          <TipCard
            title="Bring your own YAML"
            body={
              <>
                Every URL above just points to a regular YAML file — export your own canvas with{' '}
                <Link href="/editor" className="font-medium text-blue-600 hover:underline">Export → scenario.yaml</Link>{' '}
                and pass the path or self-host the file.
              </>
            }
          />
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col items-start gap-2 px-4 py-6 text-[12px] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>
            LogSim is open source under Apache 2.0.
            {index.generatedAt && (
              <>
                {' '}Scenario index regenerated {new Date(index.generatedAt).toLocaleDateString()}.
              </>
            )}
          </span>
          <div className="flex items-center gap-3">
            <a
              href={`https://github.com/${REPO_SLUG}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 hover:text-slate-900"
            >
              GitHub <ExternalLink className="h-3 w-3" />
            </a>
            <Link href="/editor" className="hover:text-slate-900">
              Editor
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Step({ number, title, children }: { number: number; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
          {number}
        </span>
        <h2 className="text-[15px] font-semibold tracking-[-0.005em] text-slate-900">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function CommandBlock({
  label,
  command,
  hint,
}: {
  label: string
  command: string
  hint?: string
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-slate-700">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
            copied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto bg-slate-950 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-slate-100">
        {command}
      </pre>
      {hint && (
        <p className="border-t border-slate-100 bg-white px-3 py-1.5 text-[11px] leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
    </div>
  )
}

function CategoryTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors',
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
      )}
    >
      {label}
    </button>
  )
}

function ScenarioRow({
  scenario,
  origin,
  groupLabel,
}: {
  scenario: ScenarioEntry
  origin: string
  groupLabel: string
}) {
  const url = `${origin}/s/${scenario.slug}.yaml`
  const editorUrl = `/s/${scenario.slug}`
  const cmd = `logsim run ${url}`
  const [expanded, setExpanded] = useState(false)
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <ChevronRight
          className={cn(
            'mt-1 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-semibold text-slate-900">{scenario.title}</span>
            <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.05em] text-slate-600">
              {groupLabel}
            </span>
            {scenario.difficulty && (
              <span
                className={cn(
                  'rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.05em]',
                  scenario.difficulty === 'easy'
                    ? 'bg-emerald-50 text-emerald-700'
                    : scenario.difficulty === 'medium'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-rose-50 text-rose-700',
                )}
              >
                {scenario.difficulty}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{scenario.description}</p>
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 pl-11">
          <RowCommand label="URL" command={url} icon={<Globe className="h-3 w-3" />} />
          <RowCommand label="CLI" command={cmd} icon={<Terminal className="h-3 w-3" />} />
          <div className="pt-1">
            <Link
              href={editorUrl}
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Open in editor
            </Link>
          </div>
        </div>
      )}
    </li>
  )
}

function RowCommand({
  label,
  command,
  icon,
}: {
  label: string
  command: string
  icon: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex w-10 shrink-0 items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-500">
        {icon}
        {label}
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11.5px] text-slate-700">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
          copied
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
        )}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function TipCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <h3 className="mb-1.5 text-[13px] font-semibold text-slate-900">{title}</h3>
      <p className="text-[12.5px] leading-relaxed text-slate-600">{body}</p>
    </div>
  )
}
