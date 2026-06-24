import { Point, InputPolygon } from '@/types/nesting'
import type { SheetImportResult } from '@/types/nesting'

const COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

function attr(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? '0') || 0
}

function rectPoints(el: Element): Point[] {
  const x = attr(el, 'x'), y = attr(el, 'y')
  const w = attr(el, 'width'), h = attr(el, 'height')
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}

function circlePoints(el: Element): Point[] {
  const cx = attr(el, 'cx'), cy = attr(el, 'cy'), r = attr(el, 'r')
  const pts: Point[] = []
  for (let i = 0; i < 32; i++) {
    const a = (2 * Math.PI * i) / 32
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

function ellipsePoints(el: Element): Point[] {
  const cx = attr(el, 'cx'), cy = attr(el, 'cy')
  const rx = attr(el, 'rx'), ry = attr(el, 'ry')
  const pts: Point[] = []
  for (let i = 0; i < 32; i++) {
    const a = (2 * Math.PI * i) / 32
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) })
  }
  return pts
}

function parsePointsAttr(raw: string): Point[] {
  const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n))
  const pts: Point[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] })
  }
  return pts
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  const pts: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    pts.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    })
  }
  return pts
}

function quadBezier(p0: Point, p1: Point, p2: Point, steps: number): Point[] {
  const pts: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    })
  }
  return pts
}

// SVG arc endpoint-to-center parameterization per the SVG spec
function arcPoints(
  x1: number, y1: number,
  rx: number, ry: number,
  xRot: number, largeArc: number, sweep: number,
  x2: number, y2: number
): Point[] {
  if (x1 === x2 && y1 === y2) return []
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }]

  const phi = (xRot * Math.PI) / 180
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi)

  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy

  let rx2 = rx * rx, ry2 = ry * ry
  const x1p2 = x1p * x1p, y1p2 = y1p * y1p
  const lambda = x1p2 / rx2 + y1p2 / ry2
  if (lambda > 1) {
    const sqrtL = Math.sqrt(lambda)
    rx *= sqrtL; ry *= sqrtL
    rx2 = rx * rx; ry2 = ry * ry
  }

  const num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2
  const den = rx2 * y1p2 + ry2 * x1p2
  const sq = Math.sqrt(Math.max(0, num / den))
  const sign = largeArc !== sweep ? 1 : -1
  const cxp = sign * sq * (rx * y1p) / ry
  const cyp = sign * sq * -(ry * x1p) / rx

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry

  const startAngle = Math.atan2(uy, ux)
  let dTheta = Math.atan2(vy, vx) - startAngle
  if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI

  const steps = Math.max(8, Math.ceil(Math.abs(dTheta) / (Math.PI / 8)))
  const pts: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const angle = startAngle + (dTheta * i) / steps
    const xp = rx * Math.cos(angle)
    const yp = ry * Math.sin(angle)
    pts.push({
      x: cosPhi * xp - sinPhi * yp + cx,
      y: sinPhi * xp + cosPhi * yp + cy,
    })
  }
  return pts
}

function parsePath(d: string): Point[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
  const allPoints: Point[] = []
  let cx = 0, cy = 0
  let startX = 0, startY = 0
  let lastCPX = 0, lastCPY = 0
  let lastCmd = ''
  let i = 0

  function n(): number { return parseFloat(tokens[i++]) }
  function pushPt(x: number, y: number) { allPoints.push({ x, y }) }

  while (i < tokens.length) {
    const tok = tokens[i]
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(tok)) {
      lastCmd = tok
      i++
    }

    const cmd = lastCmd

    if (cmd === 'M' || cmd === 'm') {
      const abs = cmd === 'M'
      const nx = abs ? n() : cx + n()
      const ny = abs ? n() : cy + n()
      cx = nx; cy = ny
      startX = cx; startY = cy
      pushPt(cx, cy)
      lastCmd = abs ? 'L' : 'l'
      lastCPX = cx; lastCPY = cy
      continue
    }

    if (cmd === 'Z' || cmd === 'z') {
      cx = startX; cy = startY
      pushPt(cx, cy)
      continue
    }

    if (cmd === 'L') { const x = n(), y = n(); cx = x; cy = y; pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }
    if (cmd === 'l') { cx += n(); cy += n(); pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }
    if (cmd === 'H') { cx = n(); pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }
    if (cmd === 'h') { cx += n(); pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }
    if (cmd === 'V') { cy = n(); pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }
    if (cmd === 'v') { cy += n(); pushPt(cx, cy); lastCPX = cx; lastCPY = cy; continue }

    if (cmd === 'C') {
      const x1 = n(), y1 = n(), x2 = n(), y2 = n(), x = n(), y = n()
      const pts = cubicBezier({ x: cx, y: cy }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x2; lastCPY = y2; cx = x; cy = y; continue
    }
    if (cmd === 'c') {
      const dx1 = n(), dy1 = n(), dx2 = n(), dy2 = n(), dx = n(), dy = n()
      const x1 = cx + dx1, y1 = cy + dy1, x2 = cx + dx2, y2 = cy + dy2, x = cx + dx, y = cy + dy
      const pts = cubicBezier({ x: cx, y: cy }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x2; lastCPY = y2; cx = x; cy = y; continue
    }

    if (cmd === 'S') {
      const reflX = 2 * cx - lastCPX, reflY = 2 * cy - lastCPY
      const x2 = n(), y2 = n(), x = n(), y = n()
      const pts = cubicBezier({ x: cx, y: cy }, { x: reflX, y: reflY }, { x: x2, y: y2 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x2; lastCPY = y2; cx = x; cy = y; continue
    }
    if (cmd === 's') {
      const reflX = 2 * cx - lastCPX, reflY = 2 * cy - lastCPY
      const dx2 = n(), dy2 = n(), dx = n(), dy = n()
      const x2 = cx + dx2, y2 = cy + dy2, x = cx + dx, y = cy + dy
      const pts = cubicBezier({ x: cx, y: cy }, { x: reflX, y: reflY }, { x: x2, y: y2 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x2; lastCPY = y2; cx = x; cy = y; continue
    }

    if (cmd === 'Q') {
      const x1 = n(), y1 = n(), x = n(), y = n()
      const pts = quadBezier({ x: cx, y: cy }, { x: x1, y: y1 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x1; lastCPY = y1; cx = x; cy = y; continue
    }
    if (cmd === 'q') {
      const dx1 = n(), dy1 = n(), dx = n(), dy = n()
      const x1 = cx + dx1, y1 = cy + dy1, x = cx + dx, y = cy + dy
      const pts = quadBezier({ x: cx, y: cy }, { x: x1, y: y1 }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x1; lastCPY = y1; cx = x; cy = y; continue
    }

    if (cmd === 'T') {
      const reflX = 2 * cx - lastCPX, reflY = 2 * cy - lastCPY
      const x = n(), y = n()
      const pts = quadBezier({ x: cx, y: cy }, { x: reflX, y: reflY }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = reflX; lastCPY = reflY; cx = x; cy = y; continue
    }
    if (cmd === 't') {
      const reflX = 2 * cx - lastCPX, reflY = 2 * cy - lastCPY
      const dx = n(), dy = n()
      const x = cx + dx, y = cy + dy
      const pts = quadBezier({ x: cx, y: cy }, { x: reflX, y: reflY }, { x, y }, 8)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = reflX; lastCPY = reflY; cx = x; cy = y; continue
    }

    if (cmd === 'A') {
      const rx = n(), ry = n(), xRot = n(), largeArc = n(), sweep = n(), x = n(), y = n()
      const pts = arcPoints(cx, cy, rx, ry, xRot, largeArc, sweep, x, y)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x; lastCPY = y; cx = x; cy = y; continue
    }
    if (cmd === 'a') {
      const rx = n(), ry = n(), xRot = n(), largeArc = n(), sweep = n(), dx = n(), dy = n()
      const x = cx + dx, y = cy + dy
      const pts = arcPoints(cx, cy, rx, ry, xRot, largeArc, sweep, x, y)
      pts.forEach(p => pushPt(p.x, p.y))
      lastCPX = x; lastCPY = y; cx = x; cy = y; continue
    }

    i++
  }

  return allPoints
}

const IGNORE_TAGS = new Set(['text', 'image', 'use', 'defs', 'mask', 'clipPath'])

function extractFromElement(el: Element, polygons: InputPolygon[], index: { value: number }, fileId: string): void {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '')

  if (IGNORE_TAGS.has(tag)) return

  if (tag === 'g') {
    for (const child of Array.from(el.children)) {
      extractFromElement(child, polygons, index, fileId)
    }
    return
  }

  let rawPoints: Point[] = []

  if (tag === 'rect') rawPoints = rectPoints(el)
  else if (tag === 'circle') rawPoints = circlePoints(el)
  else if (tag === 'ellipse') rawPoints = ellipsePoints(el)
  else if (tag === 'polygon' || tag === 'polyline') rawPoints = parsePointsAttr(el.getAttribute('points') ?? '')
  else if (tag === 'path') rawPoints = parsePath(el.getAttribute('d') ?? '')

  if (rawPoints.length < 3) return

  let minX = Infinity, minY = Infinity
  for (const p of rawPoints) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  const pts = rawPoints.map(p => ({ x: p.x - minX, y: p.y - minY }))

  const idx = index.value
  const rawId = el.id || el.getAttribute('inkscape:label') || `part-${idx}`
  const label = rawId
  const id = `${fileId}-${rawId}-${polygons.length}`
  const color = COLORS[idx % COLORS.length]

  polygons.push({ id, label, points: pts, color, quantity: 1 })
  index.value++
}

export async function parseSVG(file: File): Promise<InputPolygon[]> {
  const text = await file.text()
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const polygons: InputPolygon[] = []
  const index = { value: 0 }
  const fileId = Math.random().toString(36).slice(2, 8)

  const svgEl = doc.querySelector('svg')
  if (!svgEl) return polygons

  for (const child of Array.from(svgEl.children)) {
    extractFromElement(child, polygons, index, fileId)
  }

  return polygons
}

function circleApprox(cx: number, cy: number, r: number, n = 32): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

function ellipseApprox(cx: number, cy: number, rx: number, ry: number, tilt: number, n = 32): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    const lx = rx * Math.cos(a), ly = ry * Math.sin(a)
    return {
      x: cx + lx * Math.cos(tilt) - ly * Math.sin(tilt),
      y: cy + lx * Math.sin(tilt) + ly * Math.cos(tilt),
    }
  })
}

function normalizeToOrigin(rawPoints: Point[]): Point[] {
  let minX = Infinity, minY = Infinity
  for (const p of rawPoints) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return rawPoints.map(p => ({ x: p.x - minX, y: p.y - minY }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dxfEntityToPoints(entity: any): Point[] | null {
  if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
    const verts: Point[] = (entity.vertices ?? []).map((v: { x: number; y: number }) => ({ x: v.x, y: v.y }))
    if (verts.length < 3) return null
    // dxf-parser uses `shape` (not `closed`) for the closed flag
    if (!entity.shape) {
      const first = verts[0], last = verts[verts.length - 1]
      if (Math.hypot(first.x - last.x, first.y - last.y) > 0.01) verts.push({ ...first })
    }
    return verts
  }

  if (entity.type === 'CIRCLE') {
    const { center, radius } = entity
    return circleApprox(center.x, center.y, radius)
  }

  if (entity.type === 'ARC') {
    // dxf-parser already converts DXF degree values → radians
    const { center, radius, startAngle, endAngle } = entity
    let sweep = endAngle - startAngle
    if (sweep < 0) sweep += 2 * Math.PI
    if (sweep >= Math.PI * 1.94) return circleApprox(center.x, center.y, radius)
    const n = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 32))
    const pts: Point[] = []
    for (let i = 0; i <= n; i++) {
      const a = startAngle + (sweep * i) / n
      pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
    }
    return pts.length >= 3 ? pts : null
  }

  if (entity.type === 'ELLIPSE') {
    const { center, majorAxisEndPoint, axisRatio } = entity
    const majorR = Math.hypot(majorAxisEndPoint.x, majorAxisEndPoint.y)
    const minorR = majorR * (axisRatio ?? 1)
    const tilt = Math.atan2(majorAxisEndPoint.y, majorAxisEndPoint.x)
    return ellipseApprox(center.x, center.y, majorR, minorR, tilt)
  }

  if (entity.type === 'SPLINE') {
    const pts: Point[] = (entity.controlPoints ?? []).map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }))
    return pts.length >= 3 ? pts : null
  }

  return null
}

interface LineSegment {
  start: Point
  end: Point
  used: boolean
}

function groupLinesToPolygons(lines: LineSegment[], tol = 0.01): Point[][] {
  const result: Point[][] = []

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].used) continue

    lines[i].used = true
    const chain: Point[] = [lines[i].start, lines[i].end]

    let extended = true
    while (extended) {
      extended = false
      const last = chain[chain.length - 1]
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].used) continue
        const ds = Math.hypot(last.x - lines[j].start.x, last.y - lines[j].start.y)
        const de = Math.hypot(last.x - lines[j].end.x, last.y - lines[j].end.y)
        if (ds <= tol) {
          chain.push(lines[j].end)
          lines[j].used = true
          extended = true
          break
        } else if (de <= tol) {
          chain.push(lines[j].start)
          lines[j].used = true
          extended = true
          break
        }
      }
    }

    if (chain.length >= 4) {
      const first = chain[0], last = chain[chain.length - 1]
      if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
        result.push(chain.slice(0, -1))
      }
    }
  }

  return result
}

// Like LineSegment but carries tessellated intermediate points (for ARC segments).
interface Segment {
  start: Point
  end: Point
  pts: Point[]  // all points start→end inclusive
  used: boolean
}

// Chains LINE + ARC segments into closed polygons, preserving arc tessellation.
function groupSegmentsToPolygons(segs: Segment[], tol = 0.1): Point[][] {
  const result: Point[][] = []
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue
    segs[i].used = true
    const chain: Point[] = [...segs[i].pts]

    let extended = true
    while (extended) {
      extended = false
      const last = chain[chain.length - 1]
      for (let j = 0; j < segs.length; j++) {
        if (segs[j].used) continue
        const ds = Math.hypot(last.x - segs[j].start.x, last.y - segs[j].start.y)
        const de = Math.hypot(last.x - segs[j].end.x, last.y - segs[j].end.y)
        if (ds <= tol) {
          chain.push(...segs[j].pts.slice(1))
          segs[j].used = true; extended = true; break
        } else if (de <= tol) {
          chain.push(...[...segs[j].pts].reverse().slice(1))
          segs[j].used = true; extended = true; break
        }
      }
    }

    if (chain.length >= 4) {
      const first = chain[0], last = chain[chain.length - 1]
      if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
        result.push(chain.slice(0, -1))
      }
    }
  }
  return result
}

// Returns true if every point of `inner` lies within the bounding box of `outer`.
// Used to detect and discard inner loops (holes/slots) inside a part contour.
function bboxContains(outer: Point[], inner: Point[]): boolean {
  let oMinX = outer[0].x, oMaxX = outer[0].x, oMinY = outer[0].y, oMaxY = outer[0].y
  for (const p of outer) {
    if (p.x < oMinX) oMinX = p.x; if (p.x > oMaxX) oMaxX = p.x
    if (p.y < oMinY) oMinY = p.y; if (p.y > oMaxY) oMaxY = p.y
  }
  for (const p of inner) {
    if (p.x < oMinX - 0.1 || p.x > oMaxX + 0.1 || p.y < oMinY - 0.1 || p.y > oMaxY + 0.1) return false
  }
  return true
}

export async function parseDXF(file: File): Promise<InputPolygon[]> {
  const text = await file.text()
  const mod = await import('dxf-parser')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DxfParserClass = (mod as any).default ?? mod
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dxf = new DxfParserClass().parseSync(text)
  const polygons: InputPolygon[] = []
  let colorIdx = 0
  const fileId = Math.random().toString(36).slice(2, 8)

  // Collect LINE and ARC entities as open segments to chain into closed contours.
  // Other entity types (LWPOLYLINE, CIRCLE, ELLIPSE, SPLINE) are already closed
  // and get pushed as polygons directly.
  const allSegments: Segment[] = []

  for (const entity of dxf?.entities ?? []) {
    if (entity.type === 'LINE') {
      // dxf-parser exposes LINE as entity.start / entity.end (not entity.vertices)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = entity as any
      const sx = e.start?.x ?? e.vertices?.[0]?.x
      const sy = e.start?.y ?? e.vertices?.[0]?.y
      const ex = e.end?.x ?? e.vertices?.[e.vertices?.length - 1]?.x
      const ey = e.end?.y ?? e.vertices?.[e.vertices?.length - 1]?.y
      if (sx == null || ex == null) continue
      const s: Point = { x: sx, y: sy }
      const ep: Point = { x: ex, y: ey }
      allSegments.push({ start: s, end: ep, pts: [s, ep], used: false })
      continue
    }

    if (entity.type === 'ARC') {
      const { center, radius, startAngle, endAngle } = entity as {
        center: { x: number; y: number }; radius: number; startAngle: number; endAngle: number
      }
      let sweep = endAngle - startAngle
      if (sweep < 0) sweep += 2 * Math.PI
      if (sweep >= Math.PI * 1.94) {
        // Near-full circle → closed polygon
        const rawPts = circleApprox(center.x, center.y, radius)
        polygons.push({
          id: `${fileId}-circ-${polygons.length}`,
          label: `part-${polygons.length + 1}`,
          points: normalizeToOrigin(rawPts),
          color: COLORS[colorIdx++ % COLORS.length],
          quantity: 1,
        })
        continue
      }
      const n = Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * 32))
      const pts: Point[] = []
      for (let i = 0; i <= n; i++) {
        const a = startAngle + (sweep * i) / n
        pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
      }
      allSegments.push({ start: pts[0], end: pts[pts.length - 1], pts, used: false })
      continue
    }

    // LWPOLYLINE, POLYLINE, CIRCLE, ELLIPSE, SPLINE → already closed, push directly
    const rawPoints = dxfEntityToPoints(entity)
    if (!rawPoints || rawPoints.length < 3) continue
    const handle = (entity as { handle?: string }).handle
    polygons.push({
      id: `${fileId}-${handle ?? polygons.length}-${polygons.length}`,
      label: `part-${polygons.length + 1}`,
      points: normalizeToOrigin(rawPoints),
      color: COLORS[colorIdx++ % COLORS.length],
      quantity: 1,
    })
  }

  if (allSegments.length > 0) {
    const chains = groupSegmentsToPolygons(allSegments, 0.5)
    const outerChains = chains.filter((pts, i) =>
      !chains.some((other, j) => j !== i && bboxContains(other, pts))
    )
    const innerChains = chains.filter((pts, i) =>
      chains.some((other, j) => j !== i && bboxContains(other, pts))
    )
    for (const rawPts of outerChains) {
      if (rawPts.length < 3) continue
      // Find the outer polygon's origin so holes share the same coordinate system
      let minX = rawPts[0].x, minY = rawPts[0].y
      for (const p of rawPts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y }
      const pts = rawPts.map(p => ({ x: p.x - minX, y: p.y - minY }))
      const holes = innerChains
        .filter(h => bboxContains(rawPts, h))
        .map(h => h.map(p => ({ x: p.x - minX, y: p.y - minY })))
      polygons.push({
        id: `${fileId}-chain-${polygons.length}`,
        label: `part-${polygons.length + 1}`,
        points: pts,
        holes: holes.length > 0 ? holes : undefined,
        color: COLORS[colorIdx++ % COLORS.length],
        quantity: 1,
      })
    }
  }

  return polygons
}

export async function parseIGES(file: File): Promise<InputPolygon[]> {
  const text = await file.text()
  const fileId = Math.random().toString(36).slice(2, 8)
  const polygons: InputPolygon[] = []

  const rawLines = text.split(/\r?\n/)

  interface DirEntry { type: number; paramStart: number; paramCount: number; form: number; seqNum: number }

  const dLines: string[] = []
  const pBySeq = new Map<number, string>()

  for (const line of rawLines) {
    if (line.length < 73) continue
    const sec = line[72]
    if (sec === 'D') {
      dLines.push(line)
    } else if (sec === 'P') {
      const seq = parseInt(line.substring(73).trim())
      if (!isNaN(seq)) pBySeq.set(seq, line.substring(0, 64))
    }
  }

  const dirEntries: DirEntry[] = []
  const seqToEntry = new Map<number, DirEntry>()

  for (let i = 0; i + 1 < dLines.length; i += 2) {
    const d1 = dLines[i], d2 = dLines[i + 1]
    const type       = parseInt(d1.substring(0,  8).trim()) || 0
    const paramStart = parseInt(d1.substring(8, 16).trim()) || 0
    const paramCount = parseInt(d2.substring(24, 32).trim()) || 1
    const form       = parseInt(d2.substring(32, 40).trim()) || 0
    const seqNum     = parseInt(d1.substring(73).trim()) || (2 * i + 1)
    const e: DirEntry = { type, paramStart, paramCount, form, seqNum }
    dirEntries.push(e)
    seqToEntry.set(seqNum, e)
  }

  function getParamStr(e: DirEntry): string {
    let s = ''
    for (let i = 0; i < e.paramCount; i++) s += (pBySeq.get(e.paramStart + i) ?? '').trimEnd()
    const semi = s.indexOf(';')
    return semi >= 0 ? s.substring(0, semi) : s
  }

  function parseNums(s: string): number[] {
    return s.split(',').slice(1).map(p => parseFloat(p.trim())).filter(n => !isNaN(n))
  }

  function igesArcPts(cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): Point[] {
    const r = Math.hypot(sx - cx, sy - cy)
    if (r < 1e-9) return []
    const a1 = Math.atan2(sy - cy, sx - cx)
    let a2 = Math.atan2(ey - cy, ex - cx)
    if (Math.hypot(ex - sx, ey - sy) < 1e-6) {
      a2 = a1 + 2 * Math.PI  // full circle
    } else if (a2 < a1) {
      a2 += 2 * Math.PI
    }
    const steps = Math.max(8, Math.ceil((a2 - a1) / (Math.PI / 16)))
    return Array.from({ length: steps + 1 }, (_, i) => {
      const a = a1 + ((a2 - a1) * i) / steps
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
    })
  }

  function entityPts(e: DirEntry): Point[] {
    const n = parseNums(getParamStr(e))
    if (e.type === 110) {
      if (n.length < 6) return []
      return [{ x: n[0], y: n[1] }, { x: n[3], y: n[4] }]
    }
    if (e.type === 100) {
      if (n.length < 7) return []
      return igesArcPts(n[1], n[2], n[3], n[4], n[5], n[6])
    }
    if (e.type === 106) {
      if (n.length < 2) return []
      const ip = n[0], count = Math.round(n[1])
      const pts: Point[] = []
      if (ip === 1) {
        for (let i = 0; i < count; i++) {
          const xi = n[3 + i * 2], yi = n[4 + i * 2]
          if (isNaN(xi) || isNaN(yi)) break
          pts.push({ x: xi, y: yi })
        }
      } else {
        for (let i = 0; i < count; i++) {
          const xi = n[2 + i * 3], yi = n[3 + i * 3]
          if (isNaN(xi) || isNaN(yi)) break
          pts.push({ x: xi, y: yi })
        }
      }
      return pts
    }
    return []
  }

  let colorIdx = 0

  // Composite Curves (type 102) — preferred: each defines one closed outline
  for (const e of dirEntries) {
    if (e.type !== 102) continue
    const parts = getParamStr(e).split(',').slice(1).map(p => p.trim())
    if (!parts.length) continue
    const count = parseInt(parts[0])
    const allPts: Point[] = []
    for (let j = 0; j < count && j + 1 < parts.length; j++) {
      const comp = seqToEntry.get(parseInt(parts[j + 1]))
      if (!comp) continue
      const seg = entityPts(comp)
      if (!seg.length) continue
      allPts.push(...(allPts.length ? seg.slice(1) : seg))
    }
    if (allPts.length >= 3) {
      polygons.push({
        id: `${fileId}-cc-${polygons.length}`,
        label: `Part ${polygons.length + 1}`,
        points: normalizeToOrigin(allPts),
        color: COLORS[colorIdx++ % COLORS.length],
        quantity: 1,
      })
    }
  }

  // Fallback: group disconnected Line entities into closed loops
  if (polygons.length === 0) {
    const lineSegs: LineSegment[] = []
    for (const e of dirEntries) {
      if (e.type !== 110) continue
      const pts = entityPts(e)
      if (pts.length === 2) lineSegs.push({ start: pts[0], end: pts[1], used: false })
    }
    for (const rawPts of groupLinesToPolygons(lineSegs, 0.01)) {
      if (rawPts.length < 3) continue
      polygons.push({
        id: `${fileId}-line-group-${polygons.length}`,
        label: `Part ${polygons.length + 1}`,
        points: normalizeToOrigin(rawPts),
        color: COLORS[colorIdx++ % COLORS.length],
        quantity: 1,
      })
    }
  }

  return polygons
}

export async function parseFile(file: File): Promise<InputPolygon[]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.dxf')) return parseDXF(file)
  if (name.endsWith('.igs') || name.endsWith('.iges')) return parseIGES(file)
  return parseSVG(file)
}

// ── Sheet import (preserves relative coordinate positions) ─────────────────

function simplePolygonArea(pts: Point[]): number {
  let area = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(area) / 2
}

function overallNormalize(shapes: Point[][]): Point[][] {
  let minX = Infinity, minY = Infinity
  for (const pts of shapes) {
    for (const p of pts) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
    }
  }
  return shapes.map(pts => pts.map(p => ({ x: p.x - minX, y: p.y - minY })))
}

function extractRawFromElement(el: Element, shapes: Point[][]): void {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '')
  if (IGNORE_TAGS.has(tag)) return
  if (tag === 'g') {
    for (const child of Array.from(el.children)) extractRawFromElement(child, shapes)
    return
  }
  let rawPoints: Point[] = []
  if (tag === 'rect') rawPoints = rectPoints(el)
  else if (tag === 'circle') rawPoints = circlePoints(el)
  else if (tag === 'ellipse') rawPoints = ellipsePoints(el)
  else if (tag === 'polygon' || tag === 'polyline') rawPoints = parsePointsAttr(el.getAttribute('points') ?? '')
  else if (tag === 'path') rawPoints = parsePath(el.getAttribute('d') ?? '')
  if (rawPoints.length >= 3) shapes.push(rawPoints)
}

function parseSVGRaw(text: string): Point[][] {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const shapes: Point[][] = []
  const svgEl = doc.querySelector('svg')
  if (!svgEl) return shapes
  for (const child of Array.from(svgEl.children)) extractRawFromElement(child, shapes)
  return overallNormalize(shapes)
}

async function parseDXFRaw(file: File): Promise<Point[][]> {
  const text = await file.text()
  const mod = await import('dxf-parser')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DxfParserClass = (mod as any).default ?? mod
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dxf = new DxfParserClass().parseSync(text)
  const shapes: Point[][] = []
  const allSegments: Segment[] = []

  for (const entity of dxf?.entities ?? []) {
    if (entity.type === 'LINE') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = entity as any
      const sx = e.start?.x ?? e.vertices?.[0]?.x
      const sy = e.start?.y ?? e.vertices?.[0]?.y
      const ex = e.end?.x ?? e.vertices?.[e.vertices?.length - 1]?.x
      const ey = e.end?.y ?? e.vertices?.[e.vertices?.length - 1]?.y
      if (sx == null || ex == null) continue
      const s: Point = { x: sx, y: sy }, ep: Point = { x: ex, y: ey }
      allSegments.push({ start: s, end: ep, pts: [s, ep], used: false })
      continue
    }
    if (entity.type === 'ARC') {
      const { center, radius, startAngle, endAngle } = entity as {
        center: { x: number; y: number }; radius: number; startAngle: number; endAngle: number
      }
      let sweep = endAngle - startAngle
      if (sweep < 0) sweep += 2 * Math.PI
      if (sweep >= Math.PI * 1.94) {
        shapes.push(circleApprox(center.x, center.y, radius))
        continue
      }
      const n = Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * 32))
      const pts: Point[] = []
      for (let i = 0; i <= n; i++) {
        const a = startAngle + (sweep * i) / n
        pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
      }
      allSegments.push({ start: pts[0], end: pts[pts.length - 1], pts, used: false })
      continue
    }
    // LWPOLYLINE, CIRCLE, ELLIPSE, SPLINE — raw points (no per-entity normalization)
    const rawPoints = dxfEntityToPoints(entity)
    if (rawPoints && rawPoints.length >= 3) shapes.push(rawPoints)
  }

  if (allSegments.length > 0) {
    const chains = groupSegmentsToPolygons(allSegments, 0.5)
    for (const chain of chains) if (chain.length >= 3) shapes.push(chain)
  }

  return overallNormalize(shapes)
}

export async function parseFileForSheet(file: File): Promise<SheetImportResult | null> {
  const name = file.name.toLowerCase()
  let shapes: Point[][] = []

  if (name.endsWith('.dxf')) {
    shapes = await parseDXFRaw(file)
  } else if (name.endsWith('.igs') || name.endsWith('.iges')) {
    // IGES: reuse existing parser (per-shape normalized, relative positions may be approximate)
    const polygons = await parseIGES(file)
    shapes = polygons.map(p => p.points)
    if (shapes.length > 1) shapes = overallNormalize(shapes)
  } else {
    const text = await file.text()
    shapes = parseSVGRaw(text)
  }

  if (shapes.length === 0) return null

  // Largest shape by area = outer boundary; rest = obstacle regions
  shapes.sort((a, b) => simplePolygonArea(b) - simplePolygonArea(a))
  const boundary = shapes[0]
  const obstacles = shapes.slice(1)

  let maxX = 0, maxY = 0
  for (const p of boundary) {
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  return { boundary, obstacles, width: Math.ceil(maxX), height: Math.ceil(maxY) }
}
