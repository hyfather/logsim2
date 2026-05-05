'use client'
import React, { useMemo } from 'react'
import { CheckCircle2, Loader2, XCircle, X } from 'lucide-react'
import { useSimulationStore, type ForwardStatus } from '@/store/useSimulationStore'
import { cn } from '@/lib/utils'

/**
 * Status surface for forward-mode (Fast) runs. The backend forwards events
 * directly to a HEC destination and only streams progress, so this panel
 * mirrors the CLI's `logsim run --to <dest>` summary block instead of the
 * tick-by-tick log table that real-time mode populates.
 *
 * The panel persists past the end of the run — the user can still see the
 * final tally, error trace, and per-source breakdown until they kick off
 * the next run (which calls `forwardStarted`, replacing the snapshot) or
 * dismiss it manually.
 */
export function ForwardStatusPanel({ status }: { status: ForwardStatus }) {
  const clear = useSimulationStore(s => s.clearForwardStatus)

  const pct = status.duration > 0
    ? Math.min(100, Math.round((status.tick / status.duration) * 100))
    : status.state === 'done' ? 100 : 0

  const elapsed = useMemo(() => {
    const end = status.finishedAt ?? Date.now()
    const ms = Math.max(0, end - status.startedAt)
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1000)
    return `${m}m${s.toString().padStart(2, '0')}s`
  }, [status.startedAt, status.finishedAt])

  const topSources = useMemo(
    () => Object.entries(status.bySource).sort((a, b) => b[1] - a[1]).slice(0, 12),
    [status.bySource],
  )

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <StateBadge state={status.state} />
        <h2 className="text-[13px] font-semibold tracking-tight text-slate-900">
          Forwarding
        </h2>
        {status.destination && (
          <span className="truncate font-mono text-[11px] text-slate-500" title={status.destination}>
            → {status.destination}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-400">
          {elapsed}
        </span>
        {status.state !== 'running' && (
          <button
            type="button"
            onClick={clear}
            title="Dismiss"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed text-slate-700">
        <Counters status={status} />

        {/* Progress bar: tick-based; jumps to 100% on done. */}
        <div>
          <div className="mb-1 flex justify-between text-[11px] tabular-nums text-slate-500">
            <span>tick {status.tick.toLocaleString()} / {status.duration.toLocaleString()}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={cn(
                'h-full transition-all duration-200',
                status.state === 'error' ? 'bg-rose-500'
                  : status.state === 'done' ? 'bg-emerald-500'
                  : 'bg-blue-500',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {topSources.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Events by source
            </h3>
            <ul className="space-y-0.5">
              {topSources.map(([src, n]) => (
                <li key={src} className="flex items-baseline gap-3 tabular-nums">
                  <span className="w-20 text-right text-slate-900">{n.toLocaleString()}</span>
                  <span className="truncate text-slate-500" title={src}>{src}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {status.errors.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-rose-600">
              Errors ({status.errors.length})
            </h3>
            <ul className="space-y-0.5 text-[11px] text-rose-700">
              {status.errors.slice(-12).map((line, i) => (
                <li key={i} className="break-all">{line}</li>
              ))}
            </ul>
          </section>
        )}

        {status.errorMessage && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
            <strong className="font-semibold">Run failed:</strong> {status.errorMessage}
          </div>
        )}

        {status.state === 'done' && (
          <div className={cn(
            'rounded-md border px-3 py-2 text-[11px]',
            status.batchesFailed > 0
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900',
          )}>
            Sent {status.eventsSent.toLocaleString()} events to {status.destination || 'destination'} in{' '}
            {status.batchesSent.toLocaleString()} batches
            {status.batchesFailed > 0 && ` (${status.batchesFailed} batch(es) failed)`}.
          </div>
        )}
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: ForwardStatus['state'] }) {
  if (state === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
        <Loader2 className="size-3 animate-spin" />
        running
      </span>
    )
  }
  if (state === 'done') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <CheckCircle2 className="size-3" />
        done
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700">
      <XCircle className="size-3" />
      error
    </span>
  )
}

function Counters({ status }: { status: ForwardStatus }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      <Counter label="Sent"     value={status.eventsSent}    />
      <Counter label="Produced" value={status.eventsProduced} muted />
      <Counter label="Batches"  value={status.batchesSent}    />
      <Counter
        label="Failed"
        value={status.batchesFailed}
        tone={status.batchesFailed > 0 ? 'warn' : 'ok'}
      />
    </dl>
  )
}

function Counter({
  label, value, muted, tone,
}: {
  label: string
  value: number
  muted?: boolean
  tone?: 'ok' | 'warn'
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cn(
        'tabular-nums text-[15px] font-semibold',
        tone === 'warn' ? 'text-amber-700'
          : muted ? 'text-slate-500'
          : 'text-slate-900',
      )}>
        {value.toLocaleString()}
      </dd>
    </div>
  )
}
