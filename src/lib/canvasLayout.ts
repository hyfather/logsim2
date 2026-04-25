import type { ScenarioFlowNode, ConnectionFlowEdge } from '@/types/flow'
import type { AnchorHandleId, Connection } from '@/types/connections'
import type { NodeType } from '@/types/nodes'
import { DEFAULT_NODE_SIZES } from '@/lib/defaults'

const PADDING = 24
const HEADER = 28
const COL_GAP = 56
const ROW_GAP = 22
const SUBNET_GAP = 40
const VPC_GAP = 80
const TOP_OFFSET = 60
const LEFT_OFFSET = 60

const TIER_LABEL_HINTS: Array<{ pattern: RegExp; tier: number }> = [
  { pattern: /\b(public|edge|ingress|dmz|external)\b/i, tier: -10 },
  { pattern: /\b(data|db|database|storage|persistence)\b/i, tier: 999 },
]

interface WorldRect { x: number; y: number; width: number; height: number }
interface Box { x: number; y: number; width: number; height: number }

/**
 * Reposition every node, recompute every edge anchor, and re-fan overlapping
 * stems so the canvas reads as a clean tier diagram. Preserves node identity,
 * parentage, edge identity, and edge semantics — only positions, sizes, and
 * handle/bend hints change.
 */
export function organizeFlow(
  nodes: ScenarioFlowNode[],
  edges: ConnectionFlowEdge[],
): { nodes: ScenarioFlowNode[]; edges: ConnectionFlowEdge[] } {
  if (nodes.length === 0) return { nodes, edges }

  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenByParent = new Map<string | null, ScenarioFlowNode[]>()
  for (const n of nodes) {
    const pid = n.parentId ?? null
    const arr = childrenByParent.get(pid) ?? []
    arr.push(n)
    childrenByParent.set(pid, arr)
  }

  // ── Compute service-level depths via topological longest-path ─────────────
  const serviceIds = new Set(nodes.filter(n => n.data.type === 'service').map(n => n.id))
  function ascendToService(id: string): string | null {
    let cur = byId.get(id)
    while (cur) {
      if (cur.data.type === 'service') return cur.id
      const p = cur.data.parentId
      cur = p ? byId.get(p) : undefined
    }
    return null
  }
  const inDeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of serviceIds) {
    inDeg.set(id, 0)
    adj.set(id, [])
  }
  for (const e of edges) {
    const s = ascendToService(e.source)
    const t = ascendToService(e.target)
    if (!s || !t || s === t) continue
    adj.get(s)!.push(t)
    inDeg.set(t, (inDeg.get(t) ?? 0) + 1)
  }
  const depth = new Map<string, number>()
  const remaining = new Map(inDeg)
  const queue: string[] = []
  for (const id of serviceIds) {
    if ((inDeg.get(id) ?? 0) === 0) {
      depth.set(id, 0)
      queue.push(id)
    }
  }
  let guard = serviceIds.size * 4
  while (queue.length && guard-- > 0) {
    const u = queue.shift()!
    const d = depth.get(u) ?? 0
    for (const v of adj.get(u) ?? []) {
      depth.set(v, Math.max(depth.get(v) ?? 0, d + 1))
      remaining.set(v, (remaining.get(v) ?? 0) - 1)
      if ((remaining.get(v) ?? 0) === 0) queue.push(v)
    }
  }
  // Anything left after Kahn (cycles) gets depth 0.
  for (const id of serviceIds) if (!depth.has(id)) depth.set(id, 0)

  function tierOfNode(node: ScenarioFlowNode): number {
    if (node.data.type === 'service') return depth.get(node.id) ?? 0
    // virtual_server → tier of its services (use min, so the host sits at the
    // tier of its earliest dependency)
    const grandkids = childrenByParent.get(node.id) ?? []
    const ds: number[] = []
    const stack = [...grandkids]
    while (stack.length) {
      const n = stack.pop()!
      if (n.data.type === 'service') ds.push(depth.get(n.id) ?? 0)
      else stack.push(...(childrenByParent.get(n.id) ?? []))
    }
    return ds.length ? Math.min(...ds) : 0
  }

  function meanTierOfSubnet(node: ScenarioFlowNode): number {
    const services: number[] = []
    const stack = [...(childrenByParent.get(node.id) ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      if (n.data.type === 'service') services.push(depth.get(n.id) ?? 0)
      else stack.push(...(childrenByParent.get(n.id) ?? []))
    }
    const label = node.data.label ?? ''
    let labelBias = 0
    for (const { pattern, tier } of TIER_LABEL_HINTS) {
      if (pattern.test(label)) { labelBias = tier; break }
    }
    if (services.length === 0) return labelBias || 0
    const mean = services.reduce((a, b) => a + b, 0) / services.length
    if (labelBias < 0) return mean - 5
    if (labelBias > 0) return mean + 5
    return mean
  }

  // ── Recursive layout: every node ends up with relative (x, y, w, h) ───────
  const box = new Map<string, Box>()

  function layoutNode(id: string): { width: number; height: number } {
    const node = byId.get(id)!
    const kids = childrenByParent.get(id) ?? []
    const type = node.data.type

    if (kids.length === 0) {
      const def = DEFAULT_NODE_SIZES[type as NodeType] ?? { width: 200, height: 100 }
      const w = (node.style?.width as number | undefined) ?? def.width
      const h = (node.style?.height as number | undefined) ?? def.height
      return { width: w, height: h }
    }

    const childSizes = new Map<string, { width: number; height: number }>()
    for (const k of kids) childSizes.set(k.id, layoutNode(k.id))

    if (type === 'subnet') {
      // Tiered columns: services in the same tier stack vertically; tiers run
      // left-to-right by topological depth.
      const groups = new Map<number, ScenarioFlowNode[]>()
      for (const k of kids) {
        const t = tierOfNode(k)
        const arr = groups.get(t) ?? []
        arr.push(k)
        groups.set(t, arr)
      }
      const tiers = [...groups.keys()].sort((a, b) => a - b)

      let cursorX = PADDING
      let maxColBottom = PADDING + HEADER
      for (const t of tiers) {
        const col = groups.get(t)!
        // Stable secondary order: by label so consistent across re-layouts.
        col.sort((a, b) => (a.data.label ?? '').localeCompare(b.data.label ?? ''))
        let cursorY = PADDING + HEADER
        let colWidth = 0
        for (const k of col) {
          const sz = childSizes.get(k.id)!
          box.set(k.id, { x: cursorX, y: cursorY, width: sz.width, height: sz.height })
          cursorY += sz.height + ROW_GAP
          colWidth = Math.max(colWidth, sz.width)
        }
        cursorX += colWidth + COL_GAP
        maxColBottom = Math.max(maxColBottom, cursorY)
      }
      const width = Math.max(DEFAULT_NODE_SIZES.subnet.width, cursorX - COL_GAP + PADDING)
      const height = Math.max(DEFAULT_NODE_SIZES.subnet.height, maxColBottom + PADDING - ROW_GAP)
      return { width, height }
    }

    if (type === 'virtual_server') {
      // Stack contained services vertically inside the host.
      let cursorY = PADDING + HEADER
      let maxW = 0
      for (const k of kids) {
        const sz = childSizes.get(k.id)!
        box.set(k.id, { x: PADDING, y: cursorY, width: sz.width, height: sz.height })
        cursorY += sz.height + ROW_GAP
        maxW = Math.max(maxW, sz.width)
      }
      return {
        width: Math.max(DEFAULT_NODE_SIZES.virtual_server.width, maxW + PADDING * 2),
        height: Math.max(DEFAULT_NODE_SIZES.virtual_server.height, cursorY + PADDING - ROW_GAP),
      }
    }

    if (type === 'vpc') {
      // Subnets in a single horizontal row, ordered by mean tier.
      const subnets = kids.filter(k => k.data.type === 'subnet')
        .sort((a, b) => meanTierOfSubnet(a) - meanTierOfSubnet(b))
      const others = kids.filter(k => k.data.type !== 'subnet')
      const ordered = [...subnets, ...others]

      let cursorX = PADDING
      const top = PADDING + HEADER
      let maxH = 0
      for (const k of ordered) {
        const sz = childSizes.get(k.id)!
        box.set(k.id, { x: cursorX, y: top, width: sz.width, height: sz.height })
        cursorX += sz.width + SUBNET_GAP
        maxH = Math.max(maxH, sz.height)
      }
      return {
        width: Math.max(DEFAULT_NODE_SIZES.vpc.width, cursorX - SUBNET_GAP + PADDING),
        height: Math.max(DEFAULT_NODE_SIZES.vpc.height, top + maxH + PADDING),
      }
    }

    // Fallback: single-column stack.
    let cursorY = PADDING + HEADER
    let maxW = 0
    for (const k of kids) {
      const sz = childSizes.get(k.id)!
      box.set(k.id, { x: PADDING, y: cursorY, width: sz.width, height: sz.height })
      cursorY += sz.height + ROW_GAP
      maxW = Math.max(maxW, sz.width)
    }
    return { width: maxW + PADDING * 2, height: cursorY + PADDING - ROW_GAP }
  }

  // Layout each top-level node; place them in a row.
  const tops = childrenByParent.get(null) ?? []
  let cursorX = LEFT_OFFSET
  for (const t of tops) {
    const sz = layoutNode(t.id)
    box.set(t.id, { x: cursorX, y: TOP_OFFSET, width: sz.width, height: sz.height })
    cursorX += sz.width + VPC_GAP
  }

  // ── Build new flow nodes with updated position + size ─────────────────────
  const newNodes: ScenarioFlowNode[] = nodes.map(n => {
    const b = box.get(n.id)
    if (!b) return n
    return {
      ...n,
      position: { x: b.x, y: b.y },
      style: { ...(n.style ?? {}), width: b.width, height: b.height },
      data: { ...n.data, position: { x: b.x, y: b.y }, size: { width: b.width, height: b.height } },
    }
  })

  // ── World-coordinate rects for anchor picking ────────────────────────────
  const newById = new Map(newNodes.map(n => [n.id, n]))
  const world = new Map<string, WorldRect>()
  function worldOf(id: string): WorldRect {
    const cached = world.get(id)
    if (cached) return cached
    const n = newById.get(id)
    if (!n) {
      const empty = { x: 0, y: 0, width: 0, height: 0 }
      world.set(id, empty)
      return empty
    }
    const w = (n.style?.width as number | undefined) ?? DEFAULT_NODE_SIZES[n.data.type as NodeType]?.width ?? 200
    const h = (n.style?.height as number | undefined) ?? DEFAULT_NODE_SIZES[n.data.type as NodeType]?.height ?? 100
    if (!n.parentId) {
      const r = { x: n.position.x, y: n.position.y, width: w, height: h }
      world.set(id, r)
      return r
    }
    const p = worldOf(n.parentId)
    const r = { x: p.x + n.position.x, y: p.y + n.position.y, width: w, height: h }
    world.set(id, r)
    return r
  }
  for (const n of newNodes) worldOf(n.id)

  // ── Re-pick anchors and fan overlapping stems ─────────────────────────────
  interface Build {
    edge: ConnectionFlowEdge
    sRect: WorldRect
    tRect: WorldRect
    sourceHandle: AnchorHandleId
    targetHandle: AnchorHandleId
    bendX?: number
    bendY?: number
  }
  const builds: Build[] = []
  for (const e of edges) {
    const sRect = world.get(e.source)
    const tRect = world.get(e.target)
    if (!sRect || !tRect) {
      builds.push({
        edge: e,
        sRect: sRect ?? { x: 0, y: 0, width: 0, height: 0 },
        tRect: tRect ?? { x: 0, y: 0, width: 0, height: 0 },
        sourceHandle: 'right',
        targetHandle: 'left',
      })
      continue
    }
    const { sourceHandle, targetHandle } = pickAnchors(sRect, tRect)
    builds.push({ edge: e, sRect, tRect, sourceHandle, targetHandle })
  }

  fanBuilds(builds)

  const newEdges: ConnectionFlowEdge[] = builds.map(b => {
    const prevData = (b.edge.data ?? {}) as Connection
    const nextData: Connection = {
      ...prevData,
      sourceHandle: b.sourceHandle,
      targetHandle: b.targetHandle,
      bendX: b.bendX,
      bendY: b.bendY,
    }
    return {
      ...b.edge,
      sourceHandle: b.sourceHandle,
      targetHandle: b.targetHandle,
      data: nextData as Connection & Record<string, unknown>,
    }
  })

  return { nodes: newNodes, edges: newEdges }
}

function pickAnchors(s: WorldRect, t: WorldRect): { sourceHandle: AnchorHandleId; targetHandle: AnchorHandleId } {
  const sCx = s.x + s.width / 2
  const sCy = s.y + s.height / 2
  const tCx = t.x + t.width / 2
  const tCy = t.y + t.height / 2
  const dx = tCx - sCx
  const dy = tCy - sCy

  // Use bounding-box overlap to decide axis: when source and target share a
  // row (vertical overlap) we route horizontally; when they share a column
  // (horizontal overlap) we route vertically. This keeps the connector from
  // being drawn on top of unrelated nodes that sit between source and target.
  const yOverlap = Math.min(s.y + s.height, t.y + t.height) - Math.max(s.y, t.y)
  const xOverlap = Math.min(s.x + s.width, t.x + t.width) - Math.max(s.x, t.x)
  const SHARE = 20

  if (yOverlap > SHARE && xOverlap < 0) {
    return dx > 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' }
  }
  if (xOverlap > SHARE && yOverlap < 0) {
    return dy > 0
      ? { sourceHandle: 'bottom', targetHandle: 'top' }
      : { sourceHandle: 'top', targetHandle: 'bottom' }
  }
  // Diagonal — pick by the dominant axis. Bias slightly towards vertical so
  // sibling boxes (same row, no x-overlap) still favor side handles, but a
  // node two rows down doesn't get a near-horizontal arrow drawn through the
  // node sitting between it and the source.
  if (Math.abs(dx) >= Math.abs(dy) * 1.2) {
    return dx > 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' }
  }
  return dy > 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' }
}

const HANDLE_AXIS: Record<AnchorHandleId, 'x' | 'y'> = {
  left: 'x', right: 'x', top: 'y', bottom: 'y',
}

interface FanBuild {
  edge: ConnectionFlowEdge
  sRect: WorldRect
  tRect: WorldRect
  sourceHandle: AnchorHandleId
  targetHandle: AnchorHandleId
  bendX?: number
  bendY?: number
}

function fanBuilds(builds: FanBuild[]): void {
  if (builds.length < 2) return
  const FAN_STEP = 28

  const offsets = new Map<FanBuild, { dx: number; dy: number }>()
  for (const b of builds) offsets.set(b, { dx: 0, dy: 0 })

  function groupBy(keyFn: (b: FanBuild) => string): Map<string, FanBuild[]> {
    const m = new Map<string, FanBuild[]>()
    for (const b of builds) {
      const k = keyFn(b)
      const arr = m.get(k) ?? []
      arr.push(b)
      m.set(k, arr)
    }
    return m
  }

  function applyFan(group: FanBuild[], handle: AnchorHandleId, sortKey: 'sx' | 'sy' | 'tx' | 'ty') {
    if (group.length < 2) return
    const axis = HANDLE_AXIS[handle]
    const sortVal = (b: FanBuild) =>
      sortKey === 'sx' ? b.sRect.x :
      sortKey === 'sy' ? b.sRect.y :
      sortKey === 'tx' ? b.tRect.x : b.tRect.y
    group.sort((a, b) => sortVal(a) - sortVal(b))
    const center = (group.length - 1) / 2
    group.forEach((e, i) => {
      const delta = (i - center) * FAN_STEP
      const o = offsets.get(e)!
      if (axis === 'x') o.dx += delta
      else o.dy += delta
    })
  }

  for (const group of groupBy(b => `${b.edge.source}|${b.sourceHandle}`).values()) {
    if (group.length < 2) continue
    const h = group[0].sourceHandle
    applyFan(group, h, h === 'right' || h === 'left' ? 'ty' : 'tx')
  }
  for (const group of groupBy(b => `${b.edge.target}|${b.targetHandle}`).values()) {
    if (group.length < 2) continue
    const h = group[0].targetHandle
    applyFan(group, h, h === 'right' || h === 'left' ? 'sy' : 'sx')
  }

  for (const b of builds) {
    const o = offsets.get(b)!
    if (o.dx === 0 && o.dy === 0) continue
    const sCx = b.sRect.x + b.sRect.width / 2
    const sCy = b.sRect.y + b.sRect.height / 2
    const tCx = b.tRect.x + b.tRect.width / 2
    const tCy = b.tRect.y + b.tRect.height / 2
    b.bendX = (sCx + tCx) / 2 + o.dx
    b.bendY = (sCy + tCy) / 2 + o.dy
  }
}
