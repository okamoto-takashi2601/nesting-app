import type { InputPolygon, Point } from '@/types/nesting'
import * as pdfjs from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

type CTM = [number, number, number, number, number, number]

function multiplyMatrix(a: CTM, b: CTM): CTM {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

function applyMatrix(m: CTM, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point, steps = 8): Point[] {
  const pts: Point[] = [p0]
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

function normalizeToOrigin(pts: Point[]): Point[] {
  let minX = Infinity, minY = Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return pts.map(p => ({ x: p.x - minX, y: p.y - minY }))
}

export async function parsePDF(file: File): Promise<InputPolygon[]> {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise

  const polygons: InputPolygon[] = []
  let colorIdx = 0
  const fileId = Math.random().toString(36).slice(2, 8)

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1 })
    const pageHeight = viewport.height

    const opList = await page.getOperatorList()
    const { fnArray, argsArray } = opList

    let ctm: CTM = [1, 0, 0, 1, 0, 0]
    const ctmStack: CTM[] = []
    let currentSubpath: Point[] = []
    let subpathStart: Point = { x: 0, y: 0 }
    let curX = 0, curY = 0
    const subpaths: { pts: Point[]; closed: boolean }[] = []

    function transformPt(x: number, y: number): Point {
      const [tx, ty] = applyMatrix(ctm, x, y)
      return { x: tx, y: pageHeight - ty }
    }

    function flushSubpath(closedForcefully = false) {
      if (currentSubpath.length >= 3) {
        const pts = closedForcefully ? [...currentSubpath, subpathStart] : currentSubpath
        subpaths.push({ pts, closed: closedForcefully })
      }
      currentSubpath = []
    }

    function collectPolygons(closedOnly = false) {
      for (const sp of subpaths) {
        if (closedOnly && !sp.closed) continue
        const pts = normalizeToOrigin(sp.pts)
        if (pts.length < 3) continue
        polygons.push({
          id: `${fileId}-p${pageNum}-${polygons.length}`,
          label: `part-${polygons.length + 1}`,
          points: pts,
          color: COLORS[colorIdx++ % COLORS.length],
          quantity: 1,
        })
      }
      subpaths.length = 0
    }

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]
      const args = argsArray[i] as number[]
      switch (fn) {
        case pdfjs.OPS.save:
          ctmStack.push([...ctm] as CTM)
          break
        case pdfjs.OPS.restore:
          ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0]
          break
        case pdfjs.OPS.transform:
          ctm = multiplyMatrix(ctm, [args[0], args[1], args[2], args[3], args[4], args[5]])
          break
        case pdfjs.OPS.moveTo:
          if (currentSubpath.length >= 3) subpaths.push({ pts: currentSubpath, closed: false })
          curX = args[0]; curY = args[1]
          subpathStart = transformPt(curX, curY)
          currentSubpath = [subpathStart]
          break
        case pdfjs.OPS.lineTo:
          curX = args[0]; curY = args[1]
          currentSubpath.push(transformPt(curX, curY))
          break
        case pdfjs.OPS.curveTo: {
          const p0 = transformPt(curX, curY)
          const p1 = transformPt(args[0], args[1])
          const p2 = transformPt(args[2], args[3])
          const p3 = transformPt(args[4], args[5])
          sampleCubic(p0, p1, p2, p3).slice(1).forEach(p => currentSubpath.push(p))
          curX = args[4]; curY = args[5]
          break
        }
        case pdfjs.OPS.curveTo2: {
          // v operator: cp1 = current point
          const p0 = transformPt(curX, curY)
          const p2 = transformPt(args[0], args[1])
          const p3 = transformPt(args[2], args[3])
          sampleCubic(p0, p0, p2, p3).slice(1).forEach(p => currentSubpath.push(p))
          curX = args[2]; curY = args[3]
          break
        }
        case pdfjs.OPS.curveTo3: {
          // y operator: cp2 = endpoint
          const p0 = transformPt(curX, curY)
          const p1 = transformPt(args[0], args[1])
          const p3 = transformPt(args[2], args[3])
          sampleCubic(p0, p1, p3, p3).slice(1).forEach(p => currentSubpath.push(p))
          curX = args[2]; curY = args[3]
          break
        }
        case pdfjs.OPS.closePath:
          currentSubpath.push(subpathStart)
          subpaths.push({ pts: currentSubpath, closed: true })
          currentSubpath = []
          break
        case pdfjs.OPS.rectangle: {
          const [rx, ry, rw, rh] = args
          subpaths.push({
            pts: [
              transformPt(rx, ry),
              transformPt(rx + rw, ry),
              transformPt(rx + rw, ry + rh),
              transformPt(rx, ry + rh),
            ],
            closed: true,
          })
          break
        }
        case pdfjs.OPS.fill:
        case pdfjs.OPS.eoFill:
        case pdfjs.OPS.fillStroke:
        case pdfjs.OPS.eoFillStroke:
          flushSubpath(true)
          collectPolygons(false)
          break
        case pdfjs.OPS.stroke:
          if (currentSubpath.length >= 3) subpaths.push({ pts: currentSubpath, closed: false })
          currentSubpath = []
          collectPolygons(true)
          break
        case pdfjs.OPS.endPath:
          subpaths.length = 0
          currentSubpath = []
          break
      }
    }
  }

  return polygons
}
