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

  const runCmd = `logsim run ./${filename} --ticks ${ticks} --format ${fmt} > ${outFile}`
  const runFromUrlCmd = `logsim run ${presetUrl} --ticks ${ticks} --format ${fmt} > ${outFile}`
  const primaryRunCmd = isPristinePreset ? runFromUrlCmd : runCmd
  const installCmd = `curl -fsSL ${INSTALL_URL} | sh`

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
          {/* Primary: the run command. URL form when pristine, file path
              form (paired with the download button) when modified. */}
          <section className="space-y-2">
            <CommandBlock label="Run" command={primaryRunCmd} />
            {!isPristinePreset && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handleDownload} disabled={!yamlText} type="button" className="h-8 gap-1.5 text-[12px]">
                  <Download className="h-3.5 w-3.5" />
                  Download {filename}
                </Button>
                <p className="text-[11px] text-slate-500">
                  Save it next to where you&apos;ll run the command.
                </p>
              </div>
            )}
          </section>

          {/* Install (curl only) — kept below since most users only need it once. */}
          <section className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              Don&apos;t have logsim yet?
            </p>
            <CommandBlock
              label="Install"
              hint="Drops the binary in ~/.local/bin (or /usr/local/bin if writable)."
              command={installCmd}
            />
          </section>

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
