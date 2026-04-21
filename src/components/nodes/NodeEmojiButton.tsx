'use client'
import React, { useCallback, useMemo, useState } from 'react'
import { Check, SmilePlus } from 'lucide-react'
import { useScenarioStore } from '@/store/useScenarioStore'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const EMOJI_OPTIONS = [
  '🟩',
  '🟦',
  '🐹',
  '🐘',
  '🐬',
  '🔴',
  '🌿',
  '⚙️',
  '💻',
  '🌐',
  '🧩',
  '📦',
  '☁️',
  '🛰️',
  '🛡️',
  '⚡',
  '📡',
  '🔗',
  '🚀',
  '🧠',
  '🧪',
  '🔧',
  '📨',
  '🗄️',
]

export function NodeEmojiButton({
  nodeId,
  emoji,
  className,
}: {
  nodeId: string
  emoji: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { updateNode } = useScenarioStore()

  const uniqueOptions = useMemo(
    () => (EMOJI_OPTIONS.includes(emoji) ? EMOJI_OPTIONS : [emoji, ...EMOJI_OPTIONS]),
    [emoji]
  )

  const updateEmoji = useCallback((nextEmoji: string) => {
    updateNode(nodeId, { emoji: nextEmoji })
    setOpen(false)
  }, [nodeId, updateNode])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`nodrag nopan ${className || ''}`}
          title="Choose an emoji"
          onClick={e => {
            e.stopPropagation()
          }}
          onMouseDown={e => {
            e.stopPropagation()
          }}
          onPointerDown={e => {
            e.stopPropagation()
          }}
        >
          {emoji}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-64 rounded-2xl border-slate-200 bg-white/[0.98] p-3 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur"
        onClick={e => e.stopPropagation()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-900">Pick an icon</div>
            <div className="text-[11px] text-slate-500">Click once to update the tile.</div>
          </div>
          <SmilePlus className="h-4 w-4 text-slate-400" />
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {uniqueOptions.map(option => {
            const active = option === emoji

            return (
              <button
                key={option}
                type="button"
                className={cn(
                  'relative flex h-10 items-center justify-center rounded-xl border text-xl transition-all',
                  active
                    ? 'border-emerald-300 bg-emerald-50 shadow-[0_10px_24px_-18px_rgba(22,163,74,0.45)]'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                )}
                onClick={e => {
                  e.stopPropagation()
                  updateEmoji(option)
                }}
                onPointerDown={e => {
                  e.stopPropagation()
                }}
              >
                <span aria-hidden>{option}</span>
                {active && <Check className="pointer-events-none absolute right-1 top-1 h-3.5 w-3.5 text-emerald-600" />}
              </button>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
