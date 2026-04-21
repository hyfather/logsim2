'use client'
import React from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface MultiSelectOption {
  value: string
  label: React.ReactNode
  count?: number
  /** Optional visual marker (small colored dot). */
  dotClassName?: string
  /** Native tooltip shown on hover (e.g. full value when label is truncated). */
  title?: string
}

export function MultiSelectMenu({
  label,
  options,
  selected,
  onChange,
  triggerClassName,
  renderTriggerText,
  allValueLabel = 'All',
  headerHint,
}: {
  label: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  triggerClassName?: string
  renderTriggerText?: (selected: string[], options: MultiSelectOption[]) => React.ReactNode
  allValueLabel?: string
  /** Optional secondary text rendered under the label (e.g. shared prefix). */
  headerHint?: React.ReactNode
}) {
  const allSelected = selected.length === options.length && options.length > 0
  const noneSelected = selected.length === 0

  const defaultTriggerText = noneSelected
    ? `No ${label.toLowerCase()}`
    : allSelected
      ? allValueLabel
      : selected.length === 1
        ? options.find(o => o.value === selected[0])?.label ?? selected[0]
        : `${selected.length} ${label.toLowerCase()}`

  const triggerText = renderTriggerText
    ? renderTriggerText(selected, options)
    : defaultTriggerText

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 min-w-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700 transition-colors hover:bg-gray-50',
            triggerClassName,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{triggerText}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] w-[260px] overflow-y-auto">
        <DropdownMenuLabel className="py-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500">
            <span>{label}</span>
            <button
              type="button"
              onClick={() => onChange(allSelected ? [] : options.map(o => o.value))}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50"
            >
              {allSelected ? 'Clear' : 'All'}
            </button>
          </div>
          {headerHint && (
            <div
              className="mt-0.5 truncate font-mono text-[10px] font-normal normal-case tracking-normal text-gray-400"
              title={typeof headerHint === 'string' ? headerHint : undefined}
            >
              {headerHint}
            </div>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-gray-400">no options</div>
        )}
        {options.map(opt => {
          const isOnly = selected.length === 1 && selected[0] === opt.value
          return (
            <DropdownMenuCheckboxItem
              key={opt.value}
              checked={selected.includes(opt.value)}
              onCheckedChange={() => toggle(opt.value)}
              onSelect={(e) => e.preventDefault()}
              className="group py-1 pr-2 text-xs"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2" title={opt.title}>
                {opt.dotClassName && (
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', opt.dotClassName)} />
                )}
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onChange(isOnly ? options.map(o => o.value) : [opt.value])
                  }}
                  className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-blue-600 opacity-0 hover:bg-blue-50 group-hover:opacity-100 focus:opacity-100"
                  title={isOnly ? 'Select all' : `Select only ${typeof opt.label === 'string' ? opt.label : opt.value}`}
                >
                  {isOnly ? 'all' : 'only'}
                </button>
                {opt.count !== undefined && (
                  <span className="shrink-0 text-[10px] text-gray-400">{opt.count}</span>
                )}
              </span>
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
