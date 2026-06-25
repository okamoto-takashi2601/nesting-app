'use client'
import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import type { NestResult, SheetConfig, PlacedPart, Point } from '@/types/nesting'
import type { TFunc } from '@/lib/i18n'

interface Props {
  result: NestResult | null
  sheetConfig: SheetConfig
  isRunning?: boolean
  progress?: { current: number; total: number } | null
  boundary?: Point[]
  obstacles?: Point[][]
  editMode: boolean
  onEditModeChange: (v: boolean) => void
  editablePlaced: PlacedPart[]
  onPlacedChange: (placed: PlacedPart[]) => void
  t: TFunc
}

const PALETTE = ['#4f8ef7', '#4fcf8e', '#f7c34f', '#f77f4f', '#cf4ff7', '#4ff7e8']
const PAD = 32
const HANDLE_LIFT_PX = 22
const HANDLE_R_PX = 7

type Pt = { x: number; y: number }

type EditInteract =
  | { type: 'idle' }
  | { type: 'moving'; partId: string; origPts: Pt[]; origHoles: Pt[][] | undefined; startMmX: number; startMmY: number }
  | { type: 'rotating'; partId: string; origPts: Pt[]; origHoles: Pt[][] | undefined; cx: number; cy: number; startAngle: number }

// ── Geometry helpers ──────────────────────────────────────────────────────────

function getBounds(pts: Pt[]) {
  let minX = pts[0].x, minY = pts[0].y, maxX = pts[0].x, maxY = pts[0].y
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

function pointInPoly(px: number, py: number, pts: Pt[]) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

function closestBboxPts(b1: ReturnType<typeof getBounds>, b2: ReturnType<typeof getBounds>): [Pt, Pt] {
  const cx2 = (b2.minX + b2.maxX) / 2, cy2 = (b2.minY + b2.maxY) / 2
  const cx1 = (b1.minX + b1.maxX) / 2, cy1 = (b1.minY + b1.maxY) / 2
  return [
    { x: Math.max(b1.minX, Math.min(b1.maxX, cx2)), y: Math.max(b1.minY, Math.min(b1.maxY, cy2)) },
    { x: Math.max(b2.minX, Math.min(b2.maxX, cx1)), y: Math.max(b2.minY, Math.min(b2.maxY, cy1)) },
  ]
}

function getCentroid(pts: Pt[]): Pt {
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length }
}

function translatePts(pts: Pt[], dx: number, dy: number): Pt[] {
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }))
}

function rotatePts(pts: Pt[], cx: number, cy: number, angle: number): Pt[] {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return pts.map(p => ({
    x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
    y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
  }))
}

function getRotateHandle(pts: Pt[], scale: number): Pt {
  const b = getBounds(pts)
  return { x: (b.minX + b.maxX) / 2, y: b.minY - HANDLE_LIFT_PX / scale }
}

function getEdgeAxes(poly: Pt[]): Pt[] {
  const axes: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > 0.001) axes.push({ x: -dy / len, y: dx / len })
  }
  return axes
}

function projectOnto(poly: Pt[], axis: Pt): [number, number] {
  let min = Infinity, max = -Infinity
  for (const p of poly) {
    const d = p.x * axis.x + p.y * axis.y
    if (d < min) min = d; if (d > max) max = d
  }
  return [min, max]
}

function satCollides(a: Pt[], b: Pt[]): boolean {
  for (const axis of [...getEdgeAxes(a), ...getEdgeAxes(b)]) {
    const [minA, maxA] = projectOnto(a, axis)
    const [minB, maxB] = projectOnto(b, axis)
    if (maxA <= minB || maxB <= minA) return false
  }
  return true
}

function isContainedInBounds(pts: Pt[], boundary: Pt[] | undefined, W: number, H: number): boolean {
  for (const p of pts) {
    if (boundary && boundary.length >= 3) {
      if (!pointInPoly(p.x, p.y, boundary)) return false
    } else {
      if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return false
    }
  }
  return true
}

function isValidPlacement(
  candidatePts: Pt[],
  partId: string,
  allParts: PlacedPart[],
  boundary: Pt[] | undefined,
  obstacles: Pt[][] | undefined,
  W: number,
  H: number
): boolean {
  if (!isContainedInBounds(candidatePts, boundary, W, H)) return false
  for (const other of allParts) {
    if (other.id === partId) continue
    if (satCollides(candidatePts, other.points)) return false
  }
  if (obstacles) {
    for (const obs of obstacles) {
      if (obs.length >= 3 && satCollides(candidatePts, obs)) return false
    }
  }
  return true
}

function drawDim(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  label: string,
  scale: number,
  offsetPx: number
) {
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.5) return
  const ux = dx / len, uy = dy / len
  const nx = -uy, ny = ux
  const off = offsetPx / scale

  const d1x = x1 + nx * off, d1y = y1 + ny * off
  const d2x = x2 + nx * off, d2y = y2 + ny * off

  ctx.save()
  ctx.strokeStyle = '#475569'
  ctx.lineWidth = 0.8 / scale

  const gap = 2 / scale
  ctx.beginPath(); ctx.moveTo(x1 + nx * gap, y1 + ny * gap); ctx.lineTo(d1x + nx * gap, d1y + ny * gap); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(x2 + nx * gap, y2 + ny * gap); ctx.lineTo(d2x + nx * gap, d2y + ny * gap); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(d1x, d1y); ctx.lineTo(d2x, d2y); ctx.stroke()
  const tk = 4 / scale
  ctx.beginPath(); ctx.moveTo(d1x, d1y); ctx.lineTo(d1x + ux * tk, d1y + uy * tk); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(d2x, d2y); ctx.lineTo(d2x - ux * tk, d2y - uy * tk); ctx.stroke()

  const mx = (d1x + d2x) / 2, my = (d1y + d2y) / 2
  const fs = Math.max(5, Math.min(10, 7.5 / scale))
  ctx.fillStyle = '#64748b'
  ctx.font = `${fs}px Inter, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.save()
  ctx.translate(mx, my)
  const angle = Math.atan2(dy, dx)
  ctx.rotate(Math.abs(angle) <= Math.PI / 2 ? angle : angle - Math.PI)
  ctx.fillText(label, 0, -3 / scale)
  ctx.restore()
  ctx.restore()
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NestingCanvas({
  result, sheetConfig, isRunning, progress, boundary, obstacles,
  editMode, onEditModeChange, editablePlaced, onPlacedChange, t,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [viewScale, setViewScale] = useState(1)
  const [viewOffset, setViewOffset] = useState({ x: PAD, y: PAD })
  const [showExport, setShowExport] = useState(false)
  const [exportBlocked, setExportBlocked] = useState(false)

  // Measurement state
  const [measureMode, setMeasureMode] = useState(false)
  const [selectedPart, setSelectedPart] = useState<PlacedPart | null>(null)
  const [measurePts, setMeasurePts] = useState<Pt[]>([])
  const [measureHits, setMeasureHits] = useState<(PlacedPart | null)[]>([])
  const [hoverPt, setHoverPt] = useState<Pt | null>(null)

  // Edit state
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null)
  const [editInteract, setEditInteract] = useState<EditInteract>({ type: 'idle' })
  const [tempPart, setTempPart] = useState<PlacedPart | null>(null)

  const isDragging = useRef(false)
  const didDrag = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const dragOffset = useRef({ x: PAD, y: PAD })

  // Clear edit state on mode exit
  useEffect(() => {
    if (!editMode) {
      setSelectedEditId(null)
      setEditInteract({ type: 'idle' })
      setTempPart(null)
    }
  }, [editMode])

  // Clear measure state when entering edit mode
  useEffect(() => {
    if (editMode) {
      setMeasureMode(false)
      setSelectedPart(null)
      setMeasurePts([])
      setMeasureHits([])
      setHoverPt(null)
    }
  }, [editMode])

  // Keyboard delete in edit mode
  useEffect(() => {
    if (!editMode) return
    function handleKey(e: KeyboardEvent) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEditId && editInteract.type === 'idle') {
        const sel = editablePlaced.find(p => p.id === selectedEditId)
        if (sel && !sel.locked) {
          onPlacedChange(editablePlaced.filter(p => p.id !== selectedEditId))
          setSelectedEditId(null)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [editMode, selectedEditId, editInteract, editablePlaced, onPlacedChange])

  // Hide export warning after 2s
  useEffect(() => {
    if (!exportBlocked) return
    const timer = setTimeout(() => setExportBlocked(false), 2000)
    return () => clearTimeout(timer)
  }, [exportBlocked])

  const labelColors = useMemo(() => {
    const map = new Map<string, string>()
    if (!result) return map
    for (const part of result.placed) {
      if (!map.has(part.label)) map.set(part.label, PALETTE[map.size % PALETTE.length])
    }
    return map
  }, [result])

  const labelCounts = useMemo(() => {
    if (!result) return new Map<string, number>()
    const m = new Map<string, number>()
    for (const p of result.placed) m.set(p.label, (m.get(p.label) ?? 0) + 1)
    return m
  }, [result])

  const wasteInfo = useMemo(() => {
    if (!result || result.placed.length === 0) return null
    let x0 = sheetConfig.width, y0 = sheetConfig.height, x1 = 0, y1 = 0
    for (const p of result.placed)
      for (const pt of p.points) {
        if (pt.x < x0) x0 = pt.x; if (pt.y < y0) y0 = pt.y
        if (pt.x > x1) x1 = pt.x; if (pt.y > y1) y1 = pt.y
      }
    return {
      top:    +y0.toFixed(1),
      bottom: +(sheetConfig.height - y1).toFixed(1),
      left:   +x0.toFixed(1),
      right:  +(sheetConfig.width - x1).toFixed(1),
    }
  }, [result, sheetConfig])

  const fitView = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.width, h = canvas.height
    const fitPad = 80
    const sx = (w - fitPad * 2) / sheetConfig.width
    const sy = (h - fitPad * 2) / sheetConfig.height
    const s = Math.min(sx, sy, 4)
    const shW = sheetConfig.width * s, shH = sheetConfig.height * s
    setViewScale(s)
    setViewOffset({ x: Math.round((w - shW) / 2), y: Math.round((h - shH) / 2) })
  }, [sheetConfig])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    canvas.width = parent.clientWidth
    canvas.height = parent.clientHeight
    fitView()
  }, [sheetConfig, fitView])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => {
      canvas.width = parent.clientWidth
      canvas.height = parent.clientHeight
      fitView()
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [fitView])

  // ── Computed measurement data ─────────────────────────────────────────────

  const selInfo = useMemo(() => {
    if (!selectedPart || measureMode) return null
    const b = getBounds(selectedPart.points)
    const W = sheetConfig.width, H = sheetConfig.height
    return {
      label: selectedPart.label,
      w: +(b.maxX - b.minX).toFixed(2),
      h: +(b.maxY - b.minY).toFixed(2),
      left: +b.minX.toFixed(2),
      right: +(W - b.maxX).toFixed(2),
      top: +b.minY.toFixed(2),
      bottom: +(H - b.maxY).toFixed(2),
    }
  }, [selectedPart, measureMode, sheetConfig])

  const measureDist = useMemo(() => {
    if (!measureMode || measurePts.length !== 2) return null
    const [p1, p2] = measurePts
    return +Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2).toFixed(2)
  }, [measureMode, measurePts])

  const partGap = useMemo(() => {
    if (measureHits.length !== 2) return null
    const [h1, h2] = measureHits
    if (!h1 || !h2 || h1.id === h2.id) return null
    const b1 = getBounds(h1.points), b2 = getBounds(h2.points)
    const dx = Math.max(0, Math.max(b1.minX - b2.maxX, b2.minX - b1.maxX))
    const dy = Math.max(0, Math.max(b1.minY - b2.maxY, b2.minY - b1.maxY))
    const [cp1, cp2] = closestBboxPts(b1, b2)
    return { gap: +Math.sqrt(dx * dx + dy * dy).toFixed(2), p1: cp1, p2: cp2, label1: h1.label, label2: h2.label, parts: [h1, h2] as PlacedPart[] }
  }, [measureHits])

  // ── Draw ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const s = viewScale

    ctx.fillStyle = '#1e293b'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.translate(viewOffset.x, viewOffset.y)
    ctx.scale(s, s)

    const W = sheetConfig.width, H = sheetConfig.height

    // ── Sheet background ──
    if (boundary && boundary.length >= 3) {
      ctx.fillStyle = '#334155'
      ctx.fillRect(0, 0, W, H)

      ctx.beginPath()
      ctx.moveTo(boundary[0].x, boundary[0].y)
      for (let i = 1; i < boundary.length; i++) ctx.lineTo(boundary[i].x, boundary[i].y)
      ctx.closePath()
      ctx.fillStyle = '#ffffff'
      ctx.fill()

      ctx.save()
      ctx.beginPath()
      ctx.moveTo(boundary[0].x, boundary[0].y)
      for (let i = 1; i < boundary.length; i++) ctx.lineTo(boundary[i].x, boundary[i].y)
      ctx.closePath()
      ctx.clip()
      ctx.fillStyle = '#cbd5e1'
      for (let x = 50; x < W; x += 50)
        for (let y = 50; y < H; y += 50) {
          ctx.beginPath(); ctx.arc(x, y, 0.7 / s, 0, Math.PI * 2); ctx.fill()
        }
      ctx.restore()

      ctx.beginPath()
      ctx.moveTo(boundary[0].x, boundary[0].y)
      for (let i = 1; i < boundary.length; i++) ctx.lineTo(boundary[i].x, boundary[i].y)
      ctx.closePath()
      ctx.strokeStyle = '#94a3b8'
      ctx.lineWidth = 1.5 / s
      ctx.stroke()

      if (obstacles && obstacles.length > 0) {
        for (const obs of obstacles) {
          if (obs.length < 3) continue
          ctx.beginPath()
          ctx.moveTo(obs[0].x, obs[0].y)
          for (let i = 1; i < obs.length; i++) ctx.lineTo(obs[i].x, obs[i].y)
          ctx.closePath()
          ctx.fillStyle = 'rgba(239,68,68,0.22)'
          ctx.fill()

          ctx.save()
          ctx.beginPath()
          ctx.moveTo(obs[0].x, obs[0].y)
          for (let i = 1; i < obs.length; i++) ctx.lineTo(obs[i].x, obs[i].y)
          ctx.closePath()
          ctx.clip()
          const hatchStep = 8 / s
          const ob = getBounds(obs)
          ctx.strokeStyle = 'rgba(239,68,68,0.45)'
          ctx.lineWidth = 0.8 / s
          for (let hx = ob.minX - (ob.maxY - ob.minY); hx < ob.maxX + (ob.maxY - ob.minY); hx += hatchStep) {
            ctx.beginPath(); ctx.moveTo(hx, ob.minY); ctx.lineTo(hx + (ob.maxY - ob.minY), ob.maxY); ctx.stroke()
          }
          ctx.restore()

          ctx.beginPath()
          ctx.moveTo(obs[0].x, obs[0].y)
          for (let i = 1; i < obs.length; i++) ctx.lineTo(obs[i].x, obs[i].y)
          ctx.closePath()
          ctx.strokeStyle = '#ef4444'
          ctx.lineWidth = 1.5 / s
          ctx.setLineDash([5 / s, 3 / s])
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    } else {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#cbd5e1'
      for (let x = 50; x < W; x += 50)
        for (let y = 50; y < H; y += 50) {
          ctx.beginPath(); ctx.arc(x, y, 0.7 / s, 0, Math.PI * 2); ctx.fill()
        }
      ctx.strokeStyle = '#94a3b8'
      ctx.lineWidth = 1 / s
      ctx.strokeRect(0, 0, W, H)
    }

    // Sheet dimension lines (offset 28 — same lane as layout and margin dims)
    drawDim(ctx, 0, 0, W, 0, `${W} mm`, s, -28)
    drawDim(ctx, 0, 0, 0, H, `${H} mm`, s, 28)

    // Total layout dimensions (bounding box of all placed parts)
    const partsForDim = editablePlaced.length > 0 ? editablePlaced : (result?.placed ?? [])
    if (partsForDim.length > 0) {
      let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity
      for (const part of partsForDim) {
        for (const p of part.points) {
          if (p.x < lMinX) lMinX = p.x
          if (p.y < lMinY) lMinY = p.y
          if (p.x > lMaxX) lMaxX = p.x
          if (p.y > lMaxY) lMaxY = p.y
        }
      }
      const lW = +(lMaxX - lMinX).toFixed(1)
      const lH = +(lMaxY - lMinY).toFixed(1)

      ctx.save()
      ctx.strokeStyle = '#f472b6'
      ctx.lineWidth = 0.8 / s
      ctx.setLineDash([6 / s, 2 / s, 1 / s, 2 / s])
      ctx.strokeRect(lMinX, lMinY, lMaxX - lMinX, lMaxY - lMinY)
      ctx.setLineDash([])
      ctx.restore()

      drawDim(ctx, lMinX, H, lMaxX, H, `${lW} mm`, s, 28)
      drawDim(ctx, W, lMinY, W, lMaxY, `${lH} mm`, s, -28)
    }

    // ── Parts ──
    const partsToRender = editablePlaced.length > 0 ? editablePlaced : (result?.placed ?? [])

    // Fill pass
    for (const part of partsToRender) {
      if (part.points.length < 2) continue
      const color = labelColors.get(part.label) ?? '#4f8ef7'
      const isSelected = editMode ? part.id === selectedEditId : selectedPart?.id === part.id
      const pts = (editMode && tempPart?.id === part.id) ? tempPart.points : part.points
      const holes = (editMode && tempPart?.id === part.id) ? tempPart.holes : part.holes

      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.closePath()
      if (holes) {
        for (const hole of holes) {
          ctx.moveTo(hole[0].x, hole[0].y)
          for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y)
          ctx.closePath()
        }
      }
      ctx.fillStyle = isSelected ? color + '55' : color + '28'
      ctx.fill('evenodd')
      const isLocked = editMode && (tempPart?.id === part.id ? false : (part as PlacedPart).locked)
      if (isLocked) {
        ctx.setLineDash([5 / s, 3 / s])
        ctx.strokeStyle = '#f59e0b'
        ctx.lineWidth = 1.5 / s
      } else {
        ctx.strokeStyle = color
        ctx.lineWidth = (isSelected ? 2 : 1.2) / s
      }
      ctx.stroke()
      ctx.setLineDash([])
      if (isLocked) {
        const b2 = getBounds(pts)
        const cx2 = (b2.minX + b2.maxX) / 2
        const cy2 = (b2.minY + b2.maxY) / 2
        const fs2 = Math.max(6, Math.min(14, 10 / s))
        ctx.font = `${fs2}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#f59e0b'
        ctx.fillText('🔒', cx2, cy2)
      }
    }


    // ── Waste areas (only when not in edit mode) ──
    if (!editMode && partsToRender.length > 0 && !isRunning) {
      let x0 = W, y0 = H, x1 = 0, y1 = 0
      for (const p of partsToRender)
        for (const pt of p.points) {
          if (pt.x < x0) x0 = pt.x; if (pt.y < y0) y0 = pt.y
          if (pt.x > x1) x1 = pt.x; if (pt.y > y1) y1 = pt.y
        }
      const wTop = y0, wBot = H - y1, wLft = x0, wRgt = W - x1
      ctx.fillStyle = 'rgba(251,146,60,0.08)'
      if (wTop > 1) ctx.fillRect(0, 0, W, y0)
      if (wBot > 1) ctx.fillRect(0, y1, W, wBot)
      if (wLft > 1) ctx.fillRect(0, y0, x0, y1 - y0)
      if (wRgt > 1) ctx.fillRect(x1, y0, wRgt, y1 - y0)
      ctx.save()
      ctx.strokeStyle = '#f97316'
      ctx.lineWidth = 0.8 / s
      ctx.setLineDash([5 / s, 3 / s])
      if (wTop > 1) { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke() }
      if (wBot > 1) { ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(W, y1); ctx.stroke() }
      if (wLft > 1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.stroke() }
      if (wRgt > 1) { ctx.beginPath(); ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); ctx.stroke() }
      ctx.setLineDash([])
      ctx.restore()
      if (wTop > 1) drawDim(ctx, W, 0,  W, y0, `${wTop.toFixed(1)} mm`, s, -28)
      if (wBot > 1) drawDim(ctx, W, y1, W, H,  `${wBot.toFixed(1)} mm`, s, -28)
      if (wLft > 1) drawDim(ctx, 0,  H, x0, H, `${wLft.toFixed(1)} mm`, s, 28)
      if (wRgt > 1) drawDim(ctx, x1, H, W,  H, `${wRgt.toFixed(1)} mm`, s, 28)
    }

    // ── Selected part dims (measurement mode) ──
    if (!editMode && selectedPart && !measureMode) {
      const b = getBounds(selectedPart.points)
      const pw = b.maxX - b.minX, ph = b.maxY - b.minY
      const midY = b.minY + ph / 2, midX = b.minX + pw / 2
      ctx.save()
      ctx.strokeStyle = '#f8fafc'
      ctx.lineWidth = 1.5 / s
      ctx.setLineDash([5 / s, 3 / s])
      ctx.beginPath()
      ctx.moveTo(selectedPart.points[0].x, selectedPart.points[0].y)
      for (let i = 1; i < selectedPart.points.length; i++) ctx.lineTo(selectedPart.points[i].x, selectedPart.points[i].y)
      ctx.closePath(); ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
      drawDim(ctx, b.minX, b.minY, b.maxX, b.minY, `${pw.toFixed(1)} mm`, s, -28)
      drawDim(ctx, b.maxX, b.minY, b.maxX, b.maxY, `${ph.toFixed(1)} mm`, s, 28)
      ctx.globalAlpha = 0.7
      if (b.minX > 1) drawDim(ctx, 0, midY, b.minX, midY, `${b.minX.toFixed(1)} mm`, s, 0)
      if (W - b.maxX > 1) drawDim(ctx, b.maxX, midY, W, midY, `${(W - b.maxX).toFixed(1)} mm`, s, 0)
      if (b.minY > 1) drawDim(ctx, midX, 0, midX, b.minY, `${b.minY.toFixed(1)} mm`, s, 0)
      if (H - b.maxY > 1) drawDim(ctx, midX, b.maxY, midX, H, `${(H - b.maxY).toFixed(1)} mm`, s, 0)
      ctx.globalAlpha = 1
    }

    // ── Edit handles ──
    if (editMode && selectedEditId) {
      const sel = editablePlaced.find(p => p.id === selectedEditId)
      const pts = sel ? ((tempPart?.id === selectedEditId) ? tempPart!.points : sel.points) : null
      if (pts) {
        const b = getBounds(pts)
        const handle = getRotateHandle(pts, s)
        const topCx = (b.minX + b.maxX) / 2

        ctx.save()
        // Dashed bounding box
        ctx.strokeStyle = '#94a3b8'
        ctx.lineWidth = 1 / s
        ctx.setLineDash([4 / s, 3 / s])
        ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
        ctx.setLineDash([])

        // Line from bbox top-center to handle
        ctx.strokeStyle = '#64748b'
        ctx.lineWidth = 0.8 / s
        ctx.beginPath()
        ctx.moveTo(topCx, b.minY)
        ctx.lineTo(handle.x, handle.y)
        ctx.stroke()

        // Handle circle
        ctx.fillStyle = '#1e293b'
        ctx.strokeStyle = '#94a3b8'
        ctx.lineWidth = 1.2 / s
        ctx.beginPath()
        ctx.arc(handle.x, handle.y, HANDLE_R_PX / s, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()

        // Rotation arc symbol inside handle
        const hr = (HANDLE_R_PX - 2.5) / s
        ctx.strokeStyle = '#94a3b8'
        ctx.lineWidth = 1 / s
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.arc(handle.x, handle.y, hr, -Math.PI * 0.8, Math.PI * 0.8)
        ctx.stroke()
        // Arrow tip
        const tipAngle = Math.PI * 0.8
        const tx = handle.x + hr * Math.cos(tipAngle)
        const ty = handle.y + hr * Math.sin(tipAngle)
        const arrowSize = 2.5 / s
        ctx.beginPath()
        ctx.moveTo(tx - arrowSize * Math.cos(tipAngle - Math.PI / 2), ty - arrowSize * Math.sin(tipAngle - Math.PI / 2))
        ctx.lineTo(tx + arrowSize * Math.cos(tipAngle + 0.6), ty + arrowSize * Math.sin(tipAngle + 0.6))
        ctx.lineTo(tx + arrowSize * Math.cos(tipAngle - 0.6), ty + arrowSize * Math.sin(tipAngle - 0.6))
        ctx.closePath()
        ctx.fillStyle = '#94a3b8'
        ctx.fill()
        ctx.restore()
      }
    }

    // ── Measure tool ──
    if (!editMode && measureMode) {
      if (partGap) {
        for (const part of partGap.parts) {
          ctx.save()
          ctx.strokeStyle = '#f7c34f'
          ctx.lineWidth = 1.8 / s
          ctx.setLineDash([5 / s, 3 / s])
          ctx.beginPath()
          ctx.moveTo(part.points[0].x, part.points[0].y)
          for (let i = 1; i < part.points.length; i++) ctx.lineTo(part.points[i].x, part.points[i].y)
          ctx.closePath(); ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }
        const { p1, p2, gap } = partGap
        const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2)
        if (dist > 0.5) {
          ctx.save()
          ctx.strokeStyle = '#f7c34f'
          ctx.lineWidth = 1.5 / s
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke()
          for (const pt of [p1, p2]) {
            ctx.fillStyle = '#f7c34f'
            ctx.beginPath(); ctx.arc(pt.x, pt.y, 3 / s, 0, Math.PI * 2); ctx.fill()
          }
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2
          const fs = Math.max(6, Math.min(12, 10 / s))
          const txt = `${gap} mm`
          ctx.font = `bold ${fs}px Inter, sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
          ctx.save()
          ctx.translate(mx, my)
          const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
          ctx.rotate(Math.abs(angle) <= Math.PI / 2 ? angle : angle - Math.PI)
          const tw = ctx.measureText(txt).width
          ctx.fillStyle = 'rgba(15,23,42,0.88)'
          ctx.fillRect(-tw / 2 - 3 / s, -fs - 4 / s, tw + 6 / s, fs + 4 / s)
          ctx.fillStyle = '#f7c34f'
          ctx.fillText(txt, 0, -2 / s)
          ctx.restore(); ctx.restore()
        }
      } else {
        const pts = [...measurePts]
        if (pts.length === 1 && hoverPt) pts.push(hoverPt)
        for (const pt of measurePts) {
          ctx.save()
          ctx.fillStyle = '#f7c34f'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1 / s
          ctx.beginPath(); ctx.arc(pt.x, pt.y, 4 / s, 0, Math.PI * 2)
          ctx.fill(); ctx.stroke(); ctx.restore()
        }
        if (pts.length === 2) {
          const [p1, p2] = pts
          const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2)
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2
          ctx.save()
          ctx.strokeStyle = measurePts.length === 2 ? '#f7c34f' : '#f7c34f88'
          ctx.lineWidth = 1.5 / s
          ctx.setLineDash(measurePts.length === 2 ? [] : [5 / s, 3 / s])
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke()
          ctx.setLineDash([])
          if (dist > 1) {
            const fs = Math.max(6, Math.min(12, 10 / s))
            const txt = `${dist.toFixed(1)} mm`
            ctx.font = `bold ${fs}px Inter, sans-serif`
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
            ctx.save()
            ctx.translate(mx, my)
            const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
            ctx.rotate(Math.abs(angle) <= Math.PI / 2 ? angle : angle - Math.PI)
            const tw = ctx.measureText(txt).width
            ctx.fillStyle = 'rgba(15,23,42,0.8)'
            ctx.fillRect(-tw / 2 - 3 / s, -fs - 4 / s, tw + 6 / s, fs + 4 / s)
            ctx.fillStyle = '#f7c34f'
            ctx.fillText(txt, 0, -2 / s)
            ctx.restore(); ctx.restore()
          } else { ctx.restore() }
        }
      }
    }

    ctx.restore()
  }, [result, editMode, editablePlaced, tempPart, selectedEditId, sheetConfig, viewScale, viewOffset, labelColors, selectedPart, measureMode, measurePts, measureHits, partGap, hoverPt, isRunning, boundary, obstacles])

  // ── Canvas interaction ────────────────────────────────────────────────────

  function toSheet(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - viewOffset.x) / viewScale,
      y: (e.clientY - rect.top - viewOffset.y) / viewScale,
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const next = Math.max(0.05, Math.min(50, viewScale * factor))
    setViewScale(next)
    setViewOffset({
      x: mx - (mx - viewOffset.x) * (next / viewScale),
      y: my - (my - viewOffset.y) * (next / viewScale),
    })
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editMode && editablePlaced.length > 0) {
      const pt = toSheet(e)

      // Check rotate handle on selected part
      const selPart = editablePlaced.find(p => p.id === selectedEditId)
      if (selPart && !selPart.locked) {
        const activePts = (tempPart?.id === selectedEditId) ? tempPart!.points : selPart.points
        const handle = getRotateHandle(activePts, viewScale)
        const dx = pt.x - handle.x, dy = pt.y - handle.y
        const distPx = Math.sqrt(dx * dx + dy * dy) * viewScale
        if (distPx <= HANDLE_R_PX + 4) {
          const center = getCentroid(activePts)
          setEditInteract({
            type: 'rotating',
            partId: selPart.id,
            origPts: activePts,
            origHoles: selPart.holes,
            cx: center.x,
            cy: center.y,
            startAngle: Math.atan2(pt.y - center.y, pt.x - center.x),
          })
          return
        }
      }

      // Hit test parts (reverse for topmost)
      const hit = [...editablePlaced].reverse().find(p => pointInPoly(pt.x, pt.y, p.points))
      if (hit) {
        setSelectedEditId(hit.id)
        if (!hit.locked) {
          const activePts = (tempPart?.id === hit.id) ? tempPart!.points : hit.points
          setEditInteract({
            type: 'moving',
            partId: hit.id,
            origPts: activePts,
            origHoles: hit.holes,
            startMmX: pt.x,
            startMmY: pt.y,
          })
        }
        return
      }

      // Click on empty: deselect + pan
      setSelectedEditId(null)
    }

    isDragging.current = true
    didDrag.current = false
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragOffset.current = { x: viewOffset.x, y: viewOffset.y }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editMode && editInteract.type !== 'idle') {
      const pt = toSheet(e)
      const W = sheetConfig.width, H = sheetConfig.height

      if (editInteract.type === 'moving') {
        const dx = pt.x - editInteract.startMmX
        const dy = pt.y - editInteract.startMmY
        if (Math.abs(dx) < 0.5 / viewScale && Math.abs(dy) < 0.5 / viewScale) return
        const newPts = translatePts(editInteract.origPts, dx, dy)
        const newHoles = editInteract.origHoles?.map(h => translatePts(h, dx, dy))
        if (isValidPlacement(newPts, editInteract.partId, editablePlaced, boundary, obstacles, W, H)) {
          const base = editablePlaced.find(p => p.id === editInteract.partId)!
          setTempPart({ ...base, points: newPts, holes: newHoles })
        }
      } else if (editInteract.type === 'rotating') {
        const angle = Math.atan2(pt.y - editInteract.cy, pt.x - editInteract.cx)
        const delta = angle - editInteract.startAngle
        const newPts = rotatePts(editInteract.origPts, editInteract.cx, editInteract.cy, delta)
        const newHoles = editInteract.origHoles?.map(h => rotatePts(h, editInteract.cx, editInteract.cy, delta))
        if (isValidPlacement(newPts, editInteract.partId, editablePlaced, boundary, obstacles, W, H)) {
          const base = editablePlaced.find(p => p.id === editInteract.partId)!
          setTempPart({ ...base, points: newPts, holes: newHoles })
        }
      }
      return
    }

    if (isDragging.current) {
      const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y
      if (Math.sqrt(dx * dx + dy * dy) > 3) didDrag.current = true
      setViewOffset({ x: dragOffset.current.x + dx, y: dragOffset.current.y + dy })
    }
    if (!editMode && measureMode) setHoverPt(toSheet(e))
  }

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editMode && editInteract.type !== 'idle') {
      if (tempPart) {
        onPlacedChange(editablePlaced.map(p => p.id === tempPart.id ? tempPart : p))
        setTempPart(null)
      }
      setEditInteract({ type: 'idle' })
      return
    }

    isDragging.current = false
    if (didDrag.current) return

    const pt = toSheet(e)

    if (!editMode && measureMode) {
      const hit = result?.placed.find(p => pointInPoly(pt.x, pt.y, p.points)) ?? null
      setMeasurePts(prev => prev.length >= 2 ? [pt] : [...prev, pt])
      setMeasureHits(prev => prev.length >= 2 ? [hit] : [...prev, hit])
    } else if (!editMode) {
      if (!result) return
      const hit = result.placed.find(p => pointInPoly(pt.x, pt.y, p.points))
      setSelectedPart(hit ?? null)
    }
  }

  const handleMouseLeave = () => {
    if (editMode && editInteract.type !== 'idle') {
      if (tempPart) {
        onPlacedChange(editablePlaced.map(p => p.id === tempPart.id ? tempPart : p))
        setTempPart(null)
      }
      setEditInteract({ type: 'idle' })
    }
    isDragging.current = false
    if (!editMode && measureMode) setHoverPt(null)
  }

  function zoomBy(factor: number) {
    const canvas = canvasRef.current
    if (!canvas) return
    const cx = canvas.width / 2, cy = canvas.height / 2
    const next = Math.max(0.05, Math.min(50, viewScale * factor))
    setViewScale(next)
    setViewOffset({
      x: cx - (cx - viewOffset.x) * (next / viewScale),
      y: cy - (cy - viewOffset.y) * (next / viewScale),
    })
  }

  // ── Export ───────────────────────────────────────────────────────────────

  function tryExport(fn: () => void) {
    if (editMode) { setExportBlocked(true); return }
    fn()
  }

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  function exportSVG() {
    if (!result) return
    const W = sheetConfig.width, H = sheetConfig.height
    const pad = 50

    // Layout bounding box
    let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity
    for (const p of result.placed)
      for (const pt of p.points) {
        if (pt.x < lMinX) lMinX = pt.x; if (pt.y < lMinY) lMinY = pt.y
        if (pt.x > lMaxX) lMaxX = pt.x; if (pt.y > lMaxY) lMaxY = pt.y
      }
    const lW = lMaxX - lMinX, lH = lMaxY - lMinY
    const mTop = lMinY, mBot = H - lMaxY, mLft = lMinX, mRgt = W - lMaxX

    // Filename from most common label
    const cnt = new Map<string, number>()
    for (const p of result.placed) cnt.set(p.label, (cnt.get(p.label) ?? 0) + 1)
    const baseName = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'nesting'

    const lines = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W + pad * 2}" height="${H + pad * 2}" viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}">`,
      `<rect width="${W}" height="${H}" fill="#fff"/>`,
    ]

    // Sheet border
    if (boundary && boundary.length >= 3) {
      const bd = boundary.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z'
      lines.push(`<path d="${bd}" fill="none" stroke="#22c55e" stroke-width="1"/>`)
    } else {
      lines.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#22c55e" stroke-width="1"/>`)
    }

    // Layout bounding box
    lines.push(`<rect x="${lMinX.toFixed(2)}" y="${lMinY.toFixed(2)}" width="${lW.toFixed(2)}" height="${lH.toFixed(2)}" fill="none" stroke="#f472b6" stroke-width="0.8" stroke-dasharray="6,2,1,2"/>`)

    // Parts with holes
    for (const part of result.placed) {
      const color = labelColors.get(part.label) ?? '#4f8ef7'
      let d = part.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z'
      if (part.holes)
        for (const hole of part.holes)
          d += ' ' + hole.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z'
      lines.push(`<path fill-rule="evenodd" d="${d}" fill="${color}30" stroke="${color}" stroke-width="0.8"/>`)
    }

    const dimText = (x: number, y: number, txt: string, rotate?: string) =>
      `<text x="${x}" y="${y}" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="7" fill="#eab308" stroke="white" stroke-width="2" paint-order="stroke" stroke-linejoin="round"${rotate ? ` transform="${rotate}"` : ''}>${txt}</text>`
    const dimLine = (x1: number, y1: number, x2: number, y2: number) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#eab308" stroke-width="0.5" stroke-dasharray="3,2"/>`

    // === Width dims (below sheet) ===
    // Layout width at y = H+10
    lines.push(dimLine(lMinX, H, lMinX, H + 13))
    lines.push(dimLine(lMaxX, H, lMaxX, H + 13))
    lines.push(dimLine(lMinX, H + 10, lMaxX, H + 10))
    lines.push(dimText((lMinX + lMaxX) / 2, H + 10, `${lW.toFixed(1)}`))
    // Sheet width at y = H+24
    lines.push(dimLine(0, H, 0, H + 27))
    lines.push(dimLine(W, H, W, H + 27))
    lines.push(dimLine(0, H + 24, W, H + 24))
    lines.push(dimText(W / 2, H + 24, `${W}`))

    // === Height dims: Sheet LEFT, Layout RIGHT ===
    // Sheet height at x = -24 (left)
    lines.push(dimLine(0, 0, -27, 0))
    lines.push(dimLine(0, H, -27, H))
    lines.push(dimLine(-24, 0, -24, H))
    lines.push(dimText(-24, H / 2, `${H}`, `rotate(-90 ${-24} ${H / 2})`))
    // Layout height at x = W+10 (right — matches canvas)
    lines.push(dimLine(W, lMinY, W + 13, lMinY))
    lines.push(dimLine(W, lMaxY, W + 13, lMaxY))
    lines.push(dimLine(W + 10, lMinY, W + 10, lMaxY))
    lines.push(dimText(W + 10, (lMinY + lMaxY) / 2, `${lH.toFixed(1)}`, `rotate(90 ${W + 10} ${(lMinY + lMaxY) / 2})`))

    // === Margin dims: same rail as layout dims (W+10 right, H+10 below) ===
    if (mTop > 1) {
      lines.push(dimLine(W, 0, W + 13, 0))
      lines.push(dimLine(W, lMinY, W + 13, lMinY))
      lines.push(dimLine(W + 10, 0, W + 10, lMinY))
      lines.push(dimText(W + 10, lMinY / 2, `${mTop.toFixed(1)}`, `rotate(90 ${W + 10} ${lMinY / 2})`))
    }
    if (mBot > 1) {
      lines.push(dimLine(W, lMaxY, W + 13, lMaxY))
      lines.push(dimLine(W, H, W + 13, H))
      lines.push(dimLine(W + 10, lMaxY, W + 10, H))
      lines.push(dimText(W + 10, (lMaxY + H) / 2, `${mBot.toFixed(1)}`, `rotate(90 ${W + 10} ${(lMaxY + H) / 2})`))
    }
    if (mLft > 1) {
      lines.push(dimLine(0, H, 0, H + 13))
      lines.push(dimLine(lMinX, H, lMinX, H + 13))
      lines.push(dimLine(0, H + 10, lMinX, H + 10))
      lines.push(dimText(lMinX / 2, H + 10, `${mLft.toFixed(1)}`))
    }
    if (mRgt > 1) {
      lines.push(dimLine(lMaxX, H, lMaxX, H + 13))
      lines.push(dimLine(W, H, W, H + 13))
      lines.push(dimLine(lMaxX, H + 10, W, H + 10))
      lines.push(dimText((lMaxX + W) / 2, H + 10, `${mRgt.toFixed(1)}`))
    }

    lines.push('</svg>')
    download(new Blob([lines.join('\n')], { type: 'image/svg+xml' }), `${baseName}_layout.svg`)
  }

  function exportDXF() {
    if (!result) return
    const W = sheetConfig.width, H = sheetConfig.height
    const L: string[] = []
    const add = (...a: (string | number)[]) => a.forEach(v => L.push(String(v)))
    const fx = (x: number) => x.toFixed(4)
    const fy = (y: number) => (H - y).toFixed(4)
    const addLine = (layer: string, x1: number, y1: number, x2: number, y2: number, ltype?: string) => {
      if (ltype) add('0','LINE','8',layer,'6',ltype,'10',fx(x1),'20',fy(y1),'30','0.0000','11',fx(x2),'21',fy(y2),'31','0.0000')
      else        add('0','LINE','8',layer,        '10',fx(x1),'20',fy(y1),'30','0.0000','11',fx(x2),'21',fy(y2),'31','0.0000')
    }
    const addText = (layer: string, x: number, y: number, txt: string, rot?: number) => {
      if (rot !== undefined)
        add('0','TEXT','8',layer,'10',fx(x),'20',fy(y),'30','0.0000','40','4','1',txt,'50',rot,'72','4','11',fx(x),'21',fy(y),'31','0.0000')
      else
        add('0','TEXT','8',layer,'10',fx(x),'20',fy(y),'30','0.0000','40','4','1',txt,'72','4','11',fx(x),'21',fy(y),'31','0.0000')
    }

    // Layout bounding box
    let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity
    for (const p of result.placed)
      for (const pt of p.points) {
        if (pt.x < lMinX) lMinX = pt.x; if (pt.y < lMinY) lMinY = pt.y
        if (pt.x > lMaxX) lMaxX = pt.x; if (pt.y > lMaxY) lMaxY = pt.y
      }
    const lW = lMaxX - lMinX, lH = lMaxY - lMinY
    const mTop = lMinY, mBot = H - lMaxY, mLft = lMinX, mRgt = W - lMaxX
    const cnt = new Map<string, number>()
    for (const p of result.placed) cnt.set(p.label, (cnt.get(p.label) ?? 0) + 1)
    const baseName = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'nesting'

    add('0','SECTION','2','HEADER','9','$ACADVER','1','AC1009','0','ENDSEC')
    add('0','SECTION','2','TABLES',
      '0','TABLE','2','LTYPE','70','3',
      '0','LTYPE','2','CONTINUOUS','70','0','3','Solid line','72','65','73','0','40','0.0',
      '0','LTYPE','2','DASHED','70','0','3','__ __ __ __ __','72','65','73','2','40','0.75','49','0.5','49','-0.25',
      '0','LTYPE','2','DASHDOT','70','0','3','_._._._._._._','72','65','73','4','40','1.4','49','1.0','49','-0.25','49','0.0','49','-0.25',
      '0','ENDTAB',
      '0','TABLE','2','LAYER','70','4',
      '0','LAYER','2','0','70','0','62','7','6','CONTINUOUS',
      '0','LAYER','2','BORDER','70','0','62','3','6','CONTINUOUS',
      '0','LAYER','2','LAYOUT','70','0','62','211','6','DASHDOT',
      '0','LAYER','2','DIM','70','0','62','2','6','DASHED',
      '0','ENDTAB',
      '0','ENDSEC')
    add('0','SECTION','2','ENTITIES')

    // Sheet border
    const borderPts = boundary && boundary.length >= 3
      ? boundary
      : [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}]
    for (let i = 0; i < borderPts.length; i++) {
      const p1 = borderPts[i], p2 = borderPts[(i + 1) % borderPts.length]
      addLine('BORDER', p1.x, p1.y, p2.x, p2.y)
    }

    // Layout bounding box
    addLine('LAYOUT', lMinX, lMinY, lMaxX, lMinY, 'DASHDOT')
    addLine('LAYOUT', lMaxX, lMinY, lMaxX, lMaxY, 'DASHDOT')
    addLine('LAYOUT', lMaxX, lMaxY, lMinX, lMaxY, 'DASHDOT')
    addLine('LAYOUT', lMinX, lMaxY, lMinX, lMinY, 'DASHDOT')

    // Parts: outer boundary + holes on same layer 0
    for (const part of result.placed) {
      const pts = part.points
      for (let i = 0; i < pts.length; i++) addLine('0', pts[i].x, pts[i].y, pts[(i+1)%pts.length].x, pts[(i+1)%pts.length].y)
      if (part.holes)
        for (const hole of part.holes)
          for (let i = 0; i < hole.length; i++) addLine('0', hole[i].x, hole[i].y, hole[(i+1)%hole.length].x, hole[(i+1)%hole.length].y)
    }

    // Width dims (below sheet in SVG → negative Y in DXF Y-up)
    // Layout width at svg y = H+10
    addLine('DIM', lMinX, H, lMinX, H+13)
    addLine('DIM', lMaxX, H, lMaxX, H+13)
    addLine('DIM', lMinX, H+10, lMaxX, H+10, 'DASHED')
    addText('DIM', (lMinX+lMaxX)/2, H+10, `${lW.toFixed(1)}`)
    // Sheet width at svg y = H+24
    addLine('DIM', 0, H, 0, H+27)
    addLine('DIM', W, H, W, H+27)
    addLine('DIM', 0, H+24, W, H+24, 'DASHED')
    addText('DIM', W/2, H+24, `${W}`)

    // Height dims: Sheet LEFT, Layout RIGHT (matches canvas)
    // Sheet height at x = -24 (left)
    addLine('DIM', 0, 0, -27, 0)
    addLine('DIM', 0, H, -27, H)
    addLine('DIM', -24, 0, -24, H, 'DASHED')
    addText('DIM', -24, H/2, `${H}`, 90)
    // Layout height at x = W+10 (right)
    addLine('DIM', W, lMinY, W+13, lMinY)
    addLine('DIM', W, lMaxY, W+13, lMaxY)
    addLine('DIM', W+10, lMinY, W+10, lMaxY, 'DASHED')
    addText('DIM', W+10, (lMinY+lMaxY)/2, `${lH.toFixed(1)}`, 90)

    // Margin dims: same rail as layout dims (W+10 right, H+10 below)
    if (mTop > 1) {
      addLine('DIM', W, 0, W+13, 0)
      addLine('DIM', W, lMinY, W+13, lMinY)
      addLine('DIM', W+10, 0, W+10, lMinY, 'DASHED')
      addText('DIM', W+10, lMinY/2, `${mTop.toFixed(1)}`, 90)
    }
    if (mBot > 1) {
      addLine('DIM', W, lMaxY, W+13, lMaxY)
      addLine('DIM', W, H, W+13, H)
      addLine('DIM', W+10, lMaxY, W+10, H, 'DASHED')
      addText('DIM', W+10, (lMaxY+H)/2, `${mBot.toFixed(1)}`, 90)
    }
    if (mLft > 1) {
      addLine('DIM', 0, H, 0, H+13)
      addLine('DIM', lMinX, H, lMinX, H+13)
      addLine('DIM', 0, H+10, lMinX, H+10, 'DASHED')
      addText('DIM', lMinX/2, H+10, `${mLft.toFixed(1)}`)
    }
    if (mRgt > 1) {
      addLine('DIM', lMaxX, H, lMaxX, H+13)
      addLine('DIM', W, H, W, H+13)
      addLine('DIM', lMaxX, H+10, W, H+10, 'DASHED')
      addText('DIM', (lMaxX+W)/2, H+10, `${mRgt.toFixed(1)}`)
    }

    add('0','ENDSEC','0','EOF')
    download(new Blob([L.join('\r\n')], { type: 'application/octet-stream' }), `${baseName}_layout.dxf`)
  }

  function exportIGES() {
    if (!result) return
    const W = sheetConfig.width, H = sheetConfig.height
    const flipY = (y: number) => H - y
    const f8 = (v: string | number) => String(v).padStart(8, ' ')
    const row = (d: string, s: string, n: number) => (d + ' '.repeat(72)).slice(0, 72) + s + String(n).padStart(7, ' ')
    const segPairs: Array<{a: Point; b: Point; color: number}> = []
    const addSeg = (ax: number, ay: number, bx: number, by: number, color = 0) =>
      segPairs.push({a: {x: ax, y: flipY(ay)}, b: {x: bx, y: flipY(by)}, color})

    // Layout bounding box
    let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity
    for (const p of result.placed)
      for (const pt of p.points) {
        if (pt.x < lMinX) lMinX = pt.x; if (pt.y < lMinY) lMinY = pt.y
        if (pt.x > lMaxX) lMaxX = pt.x; if (pt.y > lMaxY) lMaxY = pt.y
      }
    const cnt = new Map<string, number>()
    for (const p of result.placed) cnt.set(p.label, (cnt.get(p.label) ?? 0) + 1)
    const baseName = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'nesting'

    // Sheet border (color 3 = green)
    const borderPts = boundary && boundary.length >= 3
      ? boundary
      : [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}]
    for (let i = 0; i < borderPts.length; i++) {
      const p1 = borderPts[i], p2 = borderPts[(i + 1) % borderPts.length]
      addSeg(p1.x, p1.y, p2.x, p2.y, 3)
    }

    // Layout bbox
    addSeg(lMinX, lMinY, lMaxX, lMinY)
    addSeg(lMaxX, lMinY, lMaxX, lMaxY)
    addSeg(lMaxX, lMaxY, lMinX, lMaxY)
    addSeg(lMinX, lMaxY, lMinX, lMinY)

    // Parts: outer boundary + holes
    for (const p of result.placed) {
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i], b = p.points[(i + 1) % p.points.length]
        addSeg(a.x, a.y, b.x, b.y)
      }
      if (p.holes)
        for (const hole of p.holes)
          for (let i = 0; i < hole.length; i++) {
            const a = hole[i], b = hole[(i + 1) % hole.length]
            addSeg(a.x, a.y, b.x, b.y)
          }
    }

    // Dimension lines (color 5 = yellow)
    const midLX = (lMinX+lMaxX)/2, midLY = (lMinY+lMaxY)/2
    addSeg(lMinX, H+10, lMaxX, H+10, 5)
    addSeg(0, H+24, W, H+24, 5)
    addSeg(-10, lMinY, -10, lMaxY, 5)
    addSeg(-24, 0, -24, H, 5)
    addSeg(midLX, 0, midLX, lMinY, 5)
    addSeg(midLX, lMaxY, midLX, H, 5)
    addSeg(0, midLY, lMinX, midLY, 5)
    addSeg(lMaxX, midLY, W, midLY, 5)

    const fileName = `${baseName}_layout.igs`
    const sL = [row(fileName, 'S', 1)]
    const gStr = '1H,,1H;,4Hnest,4Hnest,4HNEST,4HNEST,16,38,6,308,15,4HNEST,1.0,2,2HMM,1,0.001,15H               ,0.001,1.0;'
    const gL: string[] = []
    for (let p = 0, gi = 1; p < gStr.length; p += 72, gi++) gL.push(row(gStr.slice(p, p + 72), 'G', gi))
    const dL: string[] = [], pL: string[] = []
    let dS = 1, pS = 1
    for (const {a, b, color} of segPairs) {
      const pd = `110,${a.x.toFixed(3)},${a.y.toFixed(3)},0.0,${b.x.toFixed(3)},${b.y.toFixed(3)},0.0;`
      pL.push((pd + ' '.repeat(64)).slice(0, 64) + f8(dS) + 'P' + String(pS).padStart(7, ' '))
      dL.push(f8(110)+f8(pS)+f8(0)+f8(0)+f8(0)+f8(0)+f8(0)+f8(0)+'00000000'+'D'+String(dS).padStart(7,' '))
      dL.push(f8(110)+f8(0)+f8(color)+f8(1)+f8(0)+f8(0)+f8(0)+'        '+f8(0)+'D'+String(dS+1).padStart(7,' '))
      dS += 2; pS++
    }
    const tL = row('S'+String(sL.length).padStart(7)+'G'+String(gL.length).padStart(7)+'D'+String(dL.length).padStart(7)+'P'+String(pL.length).padStart(7),'T',1)
    download(new Blob([[...sL,...gL,...dL,...pL,tL].join('\r\n')+'\r\n'],{type:'application/octet-stream'}), fileName)
  }

  const sheetCx = viewOffset.x + (sheetConfig.width * viewScale) / 2
  const sheetCy = viewOffset.y + (sheetConfig.height * viewScale) / 2

  const cursorStyle =
    editInteract.type !== 'idle' ? 'grabbing' :
    editMode ? 'default' :
    measureMode ? 'crosshair' :
    isDragging.current ? 'grabbing' : 'grab'

  return (
    <div className="flex flex-col w-full h-full bg-slate-800" onClick={() => setShowExport(false)}>
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-900 border-b border-slate-700 shrink-0">
        <button onClick={fitView}
          className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors">
          {t('fit')}
        </button>
        <div className="w-px h-3.5 bg-slate-700 mx-0.5" />
        <button onClick={() => zoomBy(1.25)}
          className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors text-sm">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.25)}
          className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors text-sm">
          −
        </button>
        <span className="text-[10px] text-slate-600 ml-1 tabular-nums">{Math.round(viewScale * 100)}%</span>

        <div className="w-px h-3.5 bg-slate-700 mx-1.5" />

        {/* Measure toggle */}
        {!editMode && (
          <button
            onClick={() => {
              setMeasureMode(v => !v)
              setSelectedPart(null)
              setMeasurePts([])
              setMeasureHits([])
              setHoverPt(null)
            }}
            title={t('measureTitle')}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs transition-colors ${
              measureMode
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 8h12M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2"/>
              <line x1="5" y1="5" x2="5" y2="11" strokeWidth="1"/>
              <line x1="8" y1="5" x2="8" y2="11" strokeWidth="1"/>
              <line x1="11" y1="5" x2="11" y2="11" strokeWidth="1"/>
            </svg>
            {t('measure')}
          </button>
        )}
        {!editMode && measureMode && measurePts.length > 0 && (
          <button
            onClick={() => { setMeasurePts([]); setMeasureHits([]); setHoverPt(null) }}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {t('reset')}
          </button>
        )}

        {/* Lock / Unlock button */}
        {result && !isRunning && (
          <>
            <div className="w-px h-3.5 bg-slate-700 mx-0.5" />
            <button
              onClick={() => onEditModeChange(!editMode)}
              title={editMode ? t('lockTitle') : t('unlockTitle')}
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs transition-colors ${
                editMode
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {editMode ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="7" width="11" height="8" rx="1.5"/>
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-.9"/>
                  <circle cx="8" cy="11" r="1.1" fill="currentColor" stroke="none"/>
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="7" width="11" height="8" rx="1.5"/>
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
                  <circle cx="8" cy="11" r="1.1" fill="currentColor" stroke="none"/>
                </svg>
              )}
              {editMode ? t('unlock') : t('lock')}
            </button>
          </>
        )}

        {/* Per-part actions in edit mode */}
        {editMode && selectedEditId && (() => {
          const selPart = editablePlaced.find(p => p.id === selectedEditId)
          if (!selPart) return null
          return (
            <>
              <div className="w-px h-3.5 bg-slate-700 mx-0.5" />
              <button
                onClick={() => {
                  onPlacedChange(editablePlaced.map(p =>
                    p.id === selectedEditId ? { ...p, locked: !p.locked } : p
                  ))
                }}
                title={selPart.locked ? t('unlockPart') : t('lockPart')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
                  selPart.locked
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {selPart.locked ? '🔓' : '🔒'}
                {selPart.locked ? t('unlockPart') : t('lockPart')}
              </button>
              <button
                onClick={() => {
                  onPlacedChange(editablePlaced.filter(p => p.id !== selectedEditId))
                  setSelectedEditId(null)
                }}
                title={t('deletePart')}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
              >
                ×{t('deletePart')}
              </button>
            </>
          )
        })()}

        <div className="ml-auto flex items-center gap-2">
          {result && (
            <div className="relative">
              {exportBlocked && (
                <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap bg-orange-900/90 border border-orange-700 text-orange-300 text-[11px] px-2.5 py-1.5 rounded-lg shadow-xl z-30">
                  {t('lockToExport')}
                </div>
              )}
              {showExport && !editMode && (
                <div className="absolute top-full right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden shadow-2xl min-w-24 z-20">
                  {[{ label: 'SVG', fn: exportSVG }, { label: 'DXF', fn: exportDXF }, { label: 'IGS', fn: exportIGES }].map(opt => (
                    <button key={opt.label}
                      onClick={e => { e.stopPropagation(); opt.fn(); setShowExport(false) }}
                      className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 transition-colors">
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={e => { e.stopPropagation(); tryExport(() => setShowExport(v => !v)) }}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  editMode
                    ? 'bg-slate-800/50 text-slate-600 cursor-not-allowed'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                {t('exportFile')} ▾
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div className="relative flex-1 overflow-hidden">
        {/* Progress overlay */}
        {isRunning && (
          <div className="absolute z-10 pointer-events-none"
            style={{ left: sheetCx, top: sheetCy, transform: 'translate(-50%, -50%)' }}>
            <div className="flex flex-col items-center gap-2 bg-slate-900/95 backdrop-blur-sm rounded-xl px-5 py-3 shadow-2xl border border-slate-600">
              <div className="flex items-center gap-2.5">
                <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-600 border-t-blue-400 animate-spin shrink-0" />
                <span className="text-slate-300 text-sm font-medium">
                  {progress ? t('placingParts', { current: progress.current, total: progress.total }) : t('computing')}
                </span>
              </div>
              {progress && (
                <div className="w-44 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400 rounded-full transition-all duration-150"
                    style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Edit mode banner */}
        {editMode && !isRunning && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <div className="bg-blue-500/15 border border-blue-500/25 text-blue-400 text-[11px] px-3 py-1 rounded-full">
              {t('editModeHint')}
            </div>
          </div>
        )}

        {/* Measure hint */}
        {!editMode && measureMode && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <div className="bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] px-3 py-1 rounded-full">
              {measurePts.length === 0 ? t('measureHint0') : measurePts.length === 1 ? t('measureHint1') : t('measureHint2')}
            </div>
          </div>
        )}

        {/* Measurement info panel */}
        {!editMode && (selInfo || partGap || measureDist !== null) && (
          <div className="absolute top-3 right-3 z-10 bg-slate-900/95 border border-slate-700 rounded-xl p-3 text-[11px] min-w-44 shadow-xl">
            {selInfo && (
              <>
                <div className="text-slate-200 font-semibold mb-2">{selInfo.label}</div>
                <div className="text-slate-500 mb-1">{t('partSize')}</div>
                <div className="flex justify-between text-slate-300 mb-0.5"><span>W</span><span className="font-mono">{selInfo.w} mm</span></div>
                <div className="flex justify-between text-slate-300 mb-2"><span>H</span><span className="font-mono">{selInfo.h} mm</span></div>
                <div className="text-slate-500 mb-1">{t('distToEdge')}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-300">
                  <span>{t('left')}</span><span className="font-mono text-right">{selInfo.left} mm</span>
                  <span>{t('right')}</span><span className="font-mono text-right">{selInfo.right} mm</span>
                  <span>{t('top')}</span><span className="font-mono text-right">{selInfo.top} mm</span>
                  <span>{t('bottom')}</span><span className="font-mono text-right">{selInfo.bottom} mm</span>
                </div>
                <button onClick={() => setSelectedPart(null)} className="mt-2 text-[10px] text-slate-600 hover:text-slate-400 transition-colors">{t('dismiss')}</button>
              </>
            )}
            {partGap && (
              <>
                <div className="text-slate-500 mb-1">{t('gapBetweenParts')}</div>
                <div className="text-amber-400 font-mono font-bold text-base mb-1.5">{partGap.gap} mm</div>
                <div className="text-slate-500">{partGap.label1} → {partGap.label2}</div>
              </>
            )}
            {!partGap && measureDist !== null && (
              <>
                <div className="text-slate-500 mb-1">{t('distance')}</div>
                <div className="text-amber-400 font-mono font-bold text-base">{measureDist} mm</div>
                <div className="text-slate-500 mt-1">ΔX: {Math.abs(measurePts[1].x - measurePts[0].x).toFixed(1)} mm</div>
                <div className="text-slate-500">ΔY: {Math.abs(measurePts[1].y - measurePts[0].y).toFixed(1)} mm</div>
              </>
            )}
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ cursor: cursorStyle }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={() => { if (!measureMode && editInteract.type === 'idle') fitView() }}
        />

        <div className="absolute bottom-2 left-3 text-[10px] text-slate-600 pointer-events-none select-none">
          {editMode ? t('editModeBottom') : measureMode ? t('measureBottom') : t('defaultBottom')}
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="flex items-center gap-3 px-4 py-1.5 bg-slate-900 border-t border-slate-700 shrink-0 text-[11px] min-h-[28px]">
        {result ? (
          <>
            <span className="text-slate-400 shrink-0">
              <span className="text-slate-200 font-medium">{result.placed.length}</span> {t('partsPerSheet')}
            </span>

            <div className="w-px h-3 bg-slate-700 shrink-0" />

            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-slate-500">{t('utilization')}</span>
              <div className="w-14 h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${result.efficiency}%` }} />
              </div>
              <span className={`font-semibold ${result.efficiency >= 80 ? 'text-emerald-400' : result.efficiency >= 60 ? 'text-yellow-400' : 'text-orange-400'}`}>
                {result.efficiency}%
              </span>
            </div>

            {result.lossArea > 0 && (
              <>
                <div className="w-px h-3 bg-slate-700 shrink-0" />
                <span className="text-slate-500 shrink-0">
                  {t('lossArea')} <span className="text-slate-400">{(result.lossArea / 100).toFixed(0)} cm²</span>
                </span>
              </>
            )}

            {wasteInfo && (
              <>
                <div className="w-px h-3 bg-slate-700 shrink-0" />
                <span className="text-slate-500 shrink-0 tabular-nums">
                  {[
                    { key: 'top',    val: wasteInfo.top    },
                    { key: 'bottom', val: wasteInfo.bottom },
                    { key: 'left',   val: wasteInfo.left   },
                    { key: 'right',  val: wasteInfo.right  },
                  ].map(({ key, val }, i) => (
                    <span key={key}>
                      {i > 0 && <span className="text-slate-700 mx-1">–</span>}
                      <span className="text-slate-500">{t(key)} </span>
                      <span className="text-slate-300">{val}mm</span>
                    </span>
                  ))}
                </span>
              </>
            )}

            {editMode && (
              <>
                <div className="w-px h-3 bg-slate-700 shrink-0" />
                <span className="text-blue-400 font-medium shrink-0">{t('editModeLabel')}</span>
              </>
            )}

            <div className="ml-auto flex items-center gap-3 overflow-hidden">
              {Array.from(labelCounts.entries()).slice(0, 6).map(([label, count]) => {
                const color = labelColors.get(label) ?? '#4f8ef7'
                return (
                  <button key={label}
                    onClick={() => {
                      if (measureMode || editMode) return
                      const part = result.placed.find(p => p.label === label)
                      setSelectedPart(prev => prev?.label === label ? null : (part ?? null))
                    }}
                    className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors shrink-0">
                    <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    {label}
                    {labelCounts.size > 1 && (
                      <span className="text-slate-600 font-mono">×{count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <span className="text-slate-600">{isRunning ? t('computingStatus') : t('importAndRun')}</span>
        )}
      </div>
    </div>
  )
}
