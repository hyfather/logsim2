'use client'
import React, { useCallback, useState } from 'react'
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const REPO_SLUG = 'hyfather/logsim2'
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/master/scripts/install.sh`
const RELEASES_URL = `https://github.com/${REPO_SLUG}/releases`

interface InstallLocallyModalProps {
  open: boolean
  onClose: () => void
}

export function InstallLocallyModal({ open, onClose }: InstallLocallyModalProps) {
  const installCmd = `curl -fsSL ${INSTALL_URL} | sh`
  const fromSourceCmd = `go install github.com/${REPO_SLUG}/cmd/logsim@latest`
  const verifyCmd = `logsim --help`

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-slate-500" />
            <DialogTitle className="text-sm font-semibold text-slate-900">Install logsim2 locally</DialogTitle>
          </div>
          <DialogDescription className="text-[11.5px] text-slate-500">
            Keep the logsim CLI on your machine so you can replay scenarios offline. Same engine that runs in the browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
          {/* Step 1 — Install */}
          <section className="space-y-3">
            <StepHeader index={1} title="Install the CLI" />

            <CommandBlock
              label="Quick install"
              hint="Drops the logsim binary into ~/.local/bin (or /usr/local/bin if writable). Verifies a SHA-256 checksum when shasum is available."
              command={installCmd}
            />

            <CommandBlock
              label="Install from source"
              hint="Requires Go 1.25+. Builds the latest main and installs it on $GOPATH/bin."
              command={fromSourceCmd}
            />
          </section>

          {/* Step 2 — Verify */}
          <section className="space-y-2">
            <StepHeader index={2} title="Verify it's on your PATH" />
            <CommandBlock
              label="Sanity check"
              hint="If this prints usage, you're set. Otherwise add the install bin dir to your PATH (the installer prints the exact line to copy)."
              command={verifyCmd}
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

          <section className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
            <p className="mb-1 font-semibold text-slate-700">What you get</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>Run any exported <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10.5px]">scenario.yaml</code> offline with <code className="rounded bg-slate-100 px-1 py-px font-mono text-[10.5px]">logsim run</code>.</li>
              <li>Stream raw, JSONL, OCSF, or OTEL output to a file or pipe.</li>
              <li>No network roundtrip — the same deterministic engine, locally.</li>
            </ul>
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
