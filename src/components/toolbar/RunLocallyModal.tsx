'use client'
import React, { useCallback, useMemo, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { buildScenarioYamlForGroundTruth } from '@/lib/scenarioGroundTruth'
import { useScenarioStore } from '@/store/useScenarioStore'
import type { FlowNode, FlowEdge } from '@/store/useScenarioStore'
import type { ScenarioMetadata } from '@/types/scenario'
import type { Episode } from '@/types/episode'
import type { LogFormat } from '@/types/logs'

const REPO_SLUG = 'hyfather/logsim2'
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/master/scripts/install.sh`
const RELEASES_URL = `https://github.com/${REPO_SLUG}/releases`

interface RunLocallyModalProps {
  open: boolean
  onClose: () => void
  flowNodes: FlowNode[]
  flowEdges: FlowEdge[]
  metadata: ScenarioMetadata
  episode: Episode
  tickIntervalMs?: number
  outputFormat?: LogFormat
}

function fileSlug(name: string): string {
  const slug = (name || 'scenario').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '')
  return slug || 'scenario'
}

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// The CLI takes raw|jsonl|ocsf|otel; the toolbar exposes native|ocsf|otel.
// "native" maps to raw (one log line per event), everything else passes through.
function cliFormat(fmt: LogFormat | undefined): string {
  if (fmt === 'ocsf') return 'ocsf'
  if (fmt === 'otel') return 'otel'
  return 'jsonl'
}

export function RunLocallyModal({
  open,
  onClose,
  flowNodes,
  flowEdges,
  metadata,
  episode,
  tickIntervalMs = 1000,
  outputFormat,
}: RunLocallyModalProps) {
  const presetSlug = useScenarioStore(s => s.presetSlug)
  const pristineYaml = useScenarioStore(s => s.pristineYaml)
  const slug = useMemo(() => fileSlug(metadata.name), [metadata.name])
  const filename = `${slug}.scenario.yaml`
  const ticks = Math.max(1, episode?.duration ?? 600)
  const fmt = cliFormat(outputFormat)
  const outFile = `${slug}.${fmt === 'jsonl' ? 'jsonl' : fmt === 'ocsf' ? 'ocsf.json' : 'otel.json'}`

  const yamlText = useMemo(() => {
    if (!open) return ''
    return buildScenarioYamlForGroundTruth(flowNodes, flowEdges, metadata, {
      episode,
      tickIntervalMs,
    })
  }, [open, flowNodes, flowEdges, metadata, episode, tickIntervalMs])

  // Pristine = scenario was loaded from a known preset slug AND the on-canvas
  // YAML still byte-matches the snapshot taken at load time. When pristine, the
  // CLI can pull the YAML straight from /s/<slug>.yaml without a download step.
  const isPristinePreset = !!(presetSlug && pristineYaml && yamlText && yamlText === pristineYaml)
  const presetUrl = useMemo(() => {
    if (!presetSlug) return ''
    if (typeof window === 'undefined') return `/s/${presetSlug}.yaml`
    return `${window.location.origin}/s/${presetSlug}.yaml`
  }, [presetSlug])

  const handleDownload = useCallback(() => {
    if (!yamlText) return
    downloadText(yamlText, filename, 'application/x-yaml')
  }, [yamlText, filename])

  const runCmd = `logsim run --scenario ./${filename} --ticks ${ticks} --format ${fmt} > ${outFile}`
  const runFromUrlCmd = `logsim run ${presetUrl} --ticks ${ticks} --format ${fmt} > ${outFile}`

  const installAndRun = `curl -fsSL ${INSTALL_URL} | sh
${isPristinePreset ? runFromUrlCmd : runCmd}`

  const fromSource = `go install github.com/${REPO_SLUG}/cmd/logsim@latest
${isPristinePreset ? runFromUrlCmd : runCmd}`

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-slate-500" />
            <DialogTitle className="text-sm font-semibold text-slate-900">Run locally with the logsim CLI</DialogTitle>
          </div>
          <DialogDescription className="text-[11.5px] text-slate-500">
            Generate logs from this scenario on your own machine. The CLI is the same engine that runs in the browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
          {/* Mode note — explains why the steps below differ depending on
              whether the user has touched the canned scenario. */}
          <section
            className={cn(
              'rounded-md border px-3 py-2 text-[11px] leading-relaxed',
              isPristinePreset
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-amber-200 bg-amber-50 text-amber-800',
            )}
          >
            {isPristinePreset ? (
              <>
                <p className="mb-0.5 font-semibold">Unmodified canned scenario detected.</p>
                <p>
                  Because this scenario matches the published version at{' '}
                  <code className="rounded bg-white/70 px-1 py-px font-mono text-[10.5px]">{presetUrl}</code>,
                  the CLI can fetch it directly — no download step needed. If you
                  edit the canvas, this panel will switch to the download-and-run flow.
                </p>
              </>
            ) : (
              <>
                <p className="mb-0.5 font-semibold">
                  {presetSlug ? 'Modified scenario detected.' : 'Custom scenario.'}
                </p>
                <p>
                  {presetSlug
                    ? "Because you've changed the canned scenario, the CLI can't pull it from a URL. "
                    : 'This scenario lives only in your browser, so the CLI needs the YAML on disk. '}
                  Download the YAML below and run it with{' '}
                  <code className="rounded bg-white/70 px-1 py-px font-mono text-[10.5px]">logsim run</code>.
                </p>
              </>
            )}
          </section>

          {isPristinePreset ? (
            // ── Pristine canned scenario: skip the download, run from URL ──
            <section className="space-y-3">
              <StepHeader index={1} title="Run it" />

              <CommandBlock
                label="Quick start"
                hint="Installs the logsim binary into ~/.local/bin (or /usr/local/bin if writable), then runs the scenario from its public URL."
                command={installAndRun}
              />

              <CommandBlock
                label="Already have logsim"
                hint={`Fetches the scenario from ${presetUrl} and writes ${ticks} ticks of ${fmt.toUpperCase()} logs to ${outFile} in the current directory.`}
                command={runFromUrlCmd}
              />

              <CommandBlock
                label="Run from source"
                hint="Requires Go 1.25+. Builds the latest main and installs it on $GOPATH/bin."
                command={fromSource}
              />
            </section>
          ) : (
            // ── Modified or custom scenario: download then run from disk ──
            <>
              <section className="space-y-2">
                <StepHeader index={1} title="Download the scenario" />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={handleDownload} disabled={!yamlText} type="button" className="h-8 gap-1.5 text-[12px]">
                    <Download className="h-3.5 w-3.5" />
                    Download {filename}
                  </Button>
                  <p className="text-[11px] text-slate-500">
                    Save it somewhere, then <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10.5px]">cd</code> into that directory.
                  </p>
                </div>
              </section>

              <section className="space-y-3">
                <StepHeader index={2} title="Run it" />

                <CommandBlock
                  label="Quick start"
                  hint="Installs the logsim binary into ~/.local/bin (or /usr/local/bin if writable), then runs the scenario."
                  command={installAndRun}
                />

                <CommandBlock
                  label="Already have logsim"
                  hint={`Writes ${ticks} ticks of ${fmt.toUpperCase()} logs to ${outFile} in the current directory.`}
                  command={runCmd}
                />

                <CommandBlock
                  label="Run from source"
                  hint="Requires Go 1.25+. Builds the latest main and installs it on $GOPATH/bin."
                  command={fromSource}
                />
              </section>
            </>
          )}

          <section className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            <p className="mb-1 font-semibold text-slate-700">Need a different platform or want to verify the binary?</p>
            <p>
              Pre-built binaries for darwin/linux (amd64 + arm64) are on{' '}
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-0.5 font-medium text-blue-600 hover:underline"
              >
                GitHub Releases <ExternalLink className="h-3 w-3" />
              </a>{' '}
              with SHA-256 checksums. Windows users can <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10.5px]">go install</code> from source.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StepHeader({ index, title }: { index: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[10px] font-semibold text-white">
        {index}
      </span>
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-slate-700">{title}</span>
    </div>
  )
}

function CommandBlock({
  label,
  hint,
  command,
}: {
  label: string
  hint?: string
  command: string
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard can fail in non-secure contexts; ignore quietly
    }
  }, [command])

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-2.5 py-1.5">
        <span className="text-[11px] font-semibold text-slate-700">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
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
      <pre className="m-0 overflow-x-auto bg-slate-950 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-slate-100">
        {command}
      </pre>
      {hint && (
        <p className="border-t border-slate-100 bg-white px-2.5 py-1.5 text-[10.5px] leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
    </div>
  )
}
