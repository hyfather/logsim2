'use client'
import React, { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useEpisodeStore } from '@/store/useEpisodeStore'

export function SegmentEditorModal() {
  const { episode, editingSegmentId, setEditingSegment, updateSegment } = useEpisodeStore()
  const segment = episode.segments.find(s => s.id === editingSegmentId) || null
  const [name, setName] = useState('')
  const [ticks, setTicks] = useState(300)
  const [yaml, setYaml] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!segment) return
    setName(segment.name)
    setTicks(segment.ticks)
    setYaml(segment.scenarioYaml)
  }, [segment?.id])

  const close = () => setEditingSegment(null)

  const save = () => {
    if (!segment) return
    updateSegment(segment.id, {
      name: name.trim() || segment.name,
      ticks: Math.max(1, Math.round(ticks) || 1),
      scenarioYaml: yaml,
    })
    close()
  }

  const loadReferenceYaml = async () => {
    setLoading(true)
    try {
      const res = await fetch('/scenarios/web-service.yaml')
      if (res.ok) setYaml(await res.text())
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={!!segment} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Edit Segment {segment?.parentId && <span className="text-[10px] text-slate-400">(forked)</span>}
          </DialogTitle>
        </DialogHeader>

        {segment && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-slate-500">Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-slate-500">
                  Duration (ticks; 1 tick ≈ 1s)
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={ticks}
                  onChange={(e) => setTicks(Number(e.target.value))}
                  className="h-8 text-xs"
                />
                <div className="mt-0.5 text-[10px] text-slate-400">
                  ≈ {Math.floor(ticks / 60)}m {ticks % 60}s
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label className="text-[10px] uppercase tracking-wider text-slate-500">Scenario YAML</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={loadReferenceYaml}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : 'Load reference (web-service.yaml)'}
                </Button>
              </div>
              <Textarea
                value={yaml}
                onChange={(e) => setYaml(e.target.value)}
                rows={18}
                className="mt-1 font-mono text-[11px]"
                spellCheck={false}
              />
              <div className="mt-1 text-[10px] text-slate-400">
                This YAML is handed to the backend engine as-is each time this segment runs.
                To simulate errors or new infrastructure, fork a segment and mutate the YAML here
                (e.g. bump <code className="font-mono">error_rate</code>, add a failing service, add a new virtual_server).
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" className="text-xs" onClick={close}>Cancel</Button>
              <Button size="sm" className="text-xs" onClick={save}>Save</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
