'use client'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import NestingCanvas from '@/components/NestingCanvas'
import { parseFile, parseFileForSheet } from '@/lib/svgParser'
import { polygonArea } from '@/lib/geometry'
import type { InputPolygon, NestResult, SheetConfig, LayoutMode, Point, PlacedPart } from '@/types/nesting'

const PALETTE = ['#4f8ef7', '#4fcf8e', '#f7c34f', '#f77f4f', '#cf4ff7', '#4ff7e8']

const LAYOUT_OPTIONS: { value: LayoutMode; label: string; desc: string }[] = [
  { value: 'same',      label: 'Same direction',  desc: 'All parts at 0° — uniform grid layout' },
  { value: 'back-back', label: 'Back-to-back',     desc: 'Alternate 0°/180° — pairs nest together' },
  { value: 'chidori30', label: 'Chidori 30°',      desc: 'Stagger rows at 30° — tight chidori packing' },
  { value: 'chidori60', label: 'Chidori 60°',      desc: 'Hex stagger at 60° — honeycomb packing' },
  { value: 'free',      label: 'Free rotation',    desc: 'Test all angles — maximum yield search' },
]

function makeCirclePts(dia: number, seg = 64) {
  const r = dia / 2
  return Array.from({ length: seg }, (_, i) => {
    const a = (i / seg) * Math.PI * 2
    return { x: r + r * Math.cos(a), y: r + r * Math.sin(a) }
  })
}

function makeRectPts(w: number, h: number) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
}

function makeTrianglePts(base: number, height: number) {
  return [{ x: 0, y: height }, { x: base / 2, y: 0 }, { x: base, y: height }]
}

type ShapeType = 'circle' | 'rect' | 'triangle'

function PartPreview({ points, holes, color }: { points: { x: number; y: number }[]; holes?: { x: number; y: number }[][]; color: string }) {
  const pad = 2, size = 28
  let minX = points[0].x, maxX = points[0].x, minY = points[0].y, maxY = points[0].y
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX || 1, h = maxY - minY || 1
  const scale = (size - pad * 2) / Math.max(w, h)
  const ox = (size - w * scale) / 2, oy = (size - h * scale) / 2
  function toPath(pts: { x: number; y: number }[]) {
    return pts.map((p, i) =>
      `${i === 0 ? 'M' : 'L'}${((p.x - minX) * scale + ox).toFixed(1)},${((p.y - minY) * scale + oy).toFixed(1)}`
    ).join(' ') + ' Z'
  }
  const d = toPath(points) + (holes?.map(h => toPath(h)).join('') ?? '')
  return (
    <svg width={size} height={size} className="shrink-0 rounded">
      <path d={d} fill={`${color}33`} stroke={color} strokeWidth="1.2" fillRule="evenodd" />
    </svg>
  )
}

export default function Page() {
  const [parts, setParts] = useState<InputPolygon[]>([])
  const [sheetConfig, setSheetConfig] = useState<SheetConfig>({
    width: 500,
    height: 500,
    spacing: 5,
    rotationStep: 1,
    layoutMode: 'same',
  })
  const [nestResult, setNestResult] = useState<NestResult | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editablePlaced, setEditablePlaced] = useState<PlacedPart[]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sheetFileInputRef = useRef<HTMLInputElement>(null)

  // Parts input mode
  const [partsMode, setPartsMode] = useState<'quick' | 'import'>('quick')

  // Sheet shape import state
  const [sheetMode, setSheetMode] = useState<'import' | 'dimensions'>('dimensions')
  const [sheetBoundary, setSheetBoundary] = useState<Point[] | null>(null)
  const [sheetObstacles, setSheetObstacles] = useState<Point[][]>([])
  const [sheetImportInfo, setSheetImportInfo] = useState<string>('')

  // Primitive shape inputs
  const [shapeType, setShapeType] = useState<ShapeType>('circle')
  const [circleDia, setCircleDia] = useState('50')
  const [rectW, setRectW] = useState('50')
  const [rectH, setRectH] = useState('30')
  const [triBase, setTriBase] = useState('60')
  const [triH, setTriH] = useState('50')

  useEffect(() => {
    if (nestResult) {
      setEditablePlaced(nestResult.placed)
      setEditMode(false)
    }
  }, [nestResult])

  useEffect(() => {
    workerRef.current = new Worker('/workers/nesting.worker.js')
    workerRef.current.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'progress') {
        setNestResult(prev => ({ placed: e.data.placed, unplaced: prev?.unplaced ?? [], efficiency: prev?.efficiency ?? 0, lossArea: prev?.lossArea ?? 0, sheetsNeeded: prev?.sheetsNeeded ?? 0 }))
        setProgress({ current: e.data.current, total: e.data.total })
      } else if (e.data.type === 'result') {
        setNestResult({ placed: e.data.placed, unplaced: e.data.unplaced, efficiency: e.data.efficiency, lossArea: e.data.lossArea, sheetsNeeded: e.data.sheetsNeeded })
        setProgress(null)
        setStatus('done')
      } else if (e.data.type === 'error') {
        setErrorMsg(e.data.message)
        setStatus('error')
      }
    }
    return () => workerRef.current?.terminate()
  }, [])

  const handleFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => {
      const n = f.name.toLowerCase()
      return n.endsWith('.svg') || n.endsWith('.dxf') || n.endsWith('.igs') || n.endsWith('.iges') || f.type === 'image/svg+xml'
    })
    if (valid.length === 0) {
      setErrorMsg('Please upload SVG or DXF files')
      setStatus('error')
      return
    }
    try {
      const results = await Promise.all(valid.map(f => parseFile(f)))
      const allParsed = results.flat()
      if (allParsed.length === 0) {
        setErrorMsg('No closed shapes found in files')
        setStatus('error')
        return
      }
      setParts(prev => [...prev, ...allParsed])
      setNestResult(null)
      setStatus('idle')
      setErrorMsg('')
    } catch {
      setErrorMsg('Failed to parse file')
      setStatus('error')
    }
  }, [])

  const handleSheetFile = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    try {
      const result = await parseFileForSheet(file)
      if (!result) {
        setErrorMsg('No closed shapes found in sheet file')
        setStatus('error')
        return
      }
      setSheetBoundary(result.boundary)
      setSheetObstacles(result.obstacles)
      setSheetImportInfo(`1 boundary + ${result.obstacles.length} obstacle${result.obstacles.length !== 1 ? 's' : ''}`)
      setSheetConfig(prev => ({
        ...prev,
        width: Math.max(1, result.width),
        height: Math.max(1, result.height),
      }))
      setSheetMode('import')
      setNestResult(null)
      setStatus('idle')
      setErrorMsg('')
    } catch {
      setErrorMsg('Failed to parse sheet file')
      setStatus('error')
    }
  }, [])

  function clearSheetImport() {
    setSheetBoundary(null)
    setSheetObstacles([])
    setSheetImportInfo('')
    setSheetMode('dimensions')
    setNestResult(null)
    setStatus('idle')
  }

  function addPrimitive(polygon: InputPolygon) {
    setParts(prev => [...prev, polygon])
    setNestResult(null)
    setStatus('idle')
    setErrorMsg('')
  }

  function addShape() {
    const color = PALETTE[parts.length % PALETTE.length]
    if (shapeType === 'circle') {
      const dia = parseFloat(circleDia)
      if (!dia || dia <= 0) return
      addPrimitive({ id: `circle-${Date.now()}`, label: `φ${dia}`, points: makeCirclePts(dia), color, quantity: 1 })
    } else if (shapeType === 'rect') {
      const w = parseFloat(rectW), h = parseFloat(rectH)
      if (!w || !h || w <= 0 || h <= 0) return
      addPrimitive({ id: `rect-${Date.now()}`, label: `${w}×${h}`, points: makeRectPts(w, h), color, quantity: 1 })
    } else {
      const b = parseFloat(triBase), h = parseFloat(triH)
      if (!b || !h || b <= 0 || h <= 0) return
      addPrimitive({ id: `tri-${Date.now()}`, label: `△${b}×${h}`, points: makeTrianglePts(b, h), color, quantity: 1 })
    }
  }

  const handleCancel = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = new Worker('/workers/nesting.worker.js')
    workerRef.current.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'progress') {
        setNestResult(prev => ({ placed: e.data.placed, unplaced: prev?.unplaced ?? [], efficiency: prev?.efficiency ?? 0, lossArea: prev?.lossArea ?? 0, sheetsNeeded: prev?.sheetsNeeded ?? 0 }))
        setProgress({ current: e.data.current, total: e.data.total })
      } else if (e.data.type === 'result') {
        setNestResult({ placed: e.data.placed, unplaced: e.data.unplaced, efficiency: e.data.efficiency, lossArea: e.data.lossArea, sheetsNeeded: e.data.sheetsNeeded })
        setProgress(null)
        setStatus('done')
      } else if (e.data.type === 'error') {
        setErrorMsg(e.data.message)
        setStatus('error')
      }
    }
    setStatus('idle')
    setProgress(null)
  }, [])

  const handleNest = useCallback(() => {
    if (parts.length === 0 || !workerRef.current) return
    setStatus('running')
    setNestResult(null)
    setProgress(null)
    const sheetArea = sheetConfig.width * sheetConfig.height
    const expanded = parts.flatMap(p => {
      const area = polygonArea(p.points)
      const maxQty = area > 0 ? Math.min(Math.ceil(sheetArea / area) + 5, 2000) : 200
      return Array.from({ length: maxQty }, (_, i) => ({ ...p, id: `${p.id}-${i}` }))
    })
    const configWithShape: SheetConfig = {
      ...sheetConfig,
      boundary: sheetBoundary ?? undefined,
      obstacles: sheetObstacles.length > 0 ? sheetObstacles : undefined,
    }
    workerRef.current.postMessage({ polygons: expanded, sheetConfig: configWithShape })
  }, [parts, sheetConfig])


  const selectedLayout = LAYOUT_OPTIONS.find(o => o.value === sheetConfig.layoutMode)

  const wasteInfo = useMemo(() => {
    if (!nestResult || nestResult.placed.length === 0) return null
    let x0 = sheetConfig.width, y0 = sheetConfig.height, x1 = 0, y1 = 0
    for (const p of nestResult.placed)
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
  }, [nestResult, sheetConfig])

  const labelCounts = useMemo(() => {
    if (!nestResult) return new Map<string, number>()
    const m = new Map<string, number>()
    for (const p of nestResult.placed) m.set(p.label, (m.get(p.label) ?? 0) + 1)
    return m
  }, [nestResult])

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div
        className="w-72 shrink-0 flex flex-col bg-slate-900 border-r border-slate-700 overflow-y-auto"
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-base font-semibold text-slate-200">
            Noda Nesting App
          </h1>
          <p className="text-[10px] text-slate-600 mt-0.5">by okadev</p>
        </div>

        {/* Parts section */}
        <div className="px-4 pb-3 pt-4">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-2">Parts</div>

          {/* Mode radio */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700 mb-3">
            {(['quick', 'import'] as const).map((mode, i) => (
              <button
                key={mode}
                onClick={() => setPartsMode(mode)}
                className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${i === 0 ? '' : 'border-l border-slate-700'} ${
                  partsMode === mode
                    ? 'bg-slate-700 text-slate-100'
                    : 'bg-slate-800/50 text-slate-500 hover:text-slate-300'
                }`}
              >
                {mode === 'quick' ? 'Quick shapes' : 'Import parts'}
              </button>
            ))}
          </div>

          {partsMode === 'quick' ? (
            <>
              {/* Shape type selector */}
              <div className="flex gap-1 mb-3">
                {([
                  { type: 'circle',   icon: <circle cx="7" cy="7" r="5.5"/>,           label: 'Circle' },
                  { type: 'rect',     icon: <rect x="1.5" y="3" width="11" height="8" rx="0.5"/>, label: 'Rect' },
                  { type: 'triangle', icon: <polygon points="7,1.5 13,12.5 1,12.5"/>,   label: 'Triangle' },
                ] as { type: ShapeType; icon: React.ReactNode; label: string }[]).map(s => (
                  <button
                    key={s.type}
                    onClick={() => setShapeType(s.type)}
                    className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] font-medium transition-colors border ${
                      shapeType === s.type
                        ? 'bg-blue-950 border-blue-500/40 text-blue-400'
                        : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                      {s.icon}
                    </svg>
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Dimension inputs */}
              <div className="bg-slate-800 rounded-lg p-2.5 space-y-2">
                {shapeType === 'circle' && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500 shrink-0">Diameter</span>
                    <input
                      type="number" min="1" value={circleDia}
                      onChange={e => setCircleDia(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addShape()}
                      className="w-0 flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-400 min-w-0"
                    />
                    <span className="text-[10px] text-slate-600 shrink-0">mm</span>
                  </div>
                )}

                {shapeType === 'rect' && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" min="1" value={rectW}
                      onChange={e => setRectW(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addShape()}
                      placeholder="W"
                      className="w-0 flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-400 min-w-0"
                    />
                    <span className="text-[10px] text-slate-600 shrink-0">×</span>
                    <input
                      type="number" min="1" value={rectH}
                      onChange={e => setRectH(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addShape()}
                      placeholder="H"
                      className="w-0 flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-400 min-w-0"
                    />
                    <span className="text-[10px] text-slate-600 shrink-0">mm</span>
                  </div>
                )}

                {shapeType === 'triangle' && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" min="1" value={triBase}
                      onChange={e => setTriBase(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addShape()}
                      placeholder="Base"
                      className="w-0 flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-400 min-w-0"
                    />
                    <span className="text-[10px] text-slate-600 shrink-0">×</span>
                    <input
                      type="number" min="1" value={triH}
                      onChange={e => setTriH(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addShape()}
                      placeholder="H"
                      className="w-0 flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-400 min-w-0"
                    />
                    <span className="text-[10px] text-slate-600 shrink-0">mm</span>
                  </div>
                )}

                <button onClick={addShape}
                  className="w-full py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs text-slate-300 transition-colors">
                  + Add {shapeType === 'circle' ? 'Circle' : shapeType === 'rect' ? 'Rectangle' : 'Triangle'}
                </button>
              </div>
            </>
          ) : (
            /* Import parts */
            <>
              <div
                className="border-2 border-dashed border-slate-700 rounded-lg p-5 text-center cursor-pointer hover:border-blue-500/40 hover:bg-slate-800/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); const f = Array.from(e.dataTransfer.files); if (f.length) handleFiles(f) }}
                onDragOver={e => e.preventDefault()}
              >
                <p className="text-xs text-slate-400">Drop SVG / DXF / IGS or click</p>
                <p className="text-[10px] text-slate-600 mt-1">Multiple files supported</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg,.dxf,.igs,.iges,image/svg+xml"
                multiple
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length > 0) handleFiles(files)
                  e.target.value = ''
                }}
              />
            </>
          )}
        </div>

        {/* Parts list */}
        {parts.length > 0 && (
          <div className="px-4 pb-2">
            <div className="border-t border-slate-700 mb-2" />
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                Parts ({parts.length})
              </span>
              <button
                onClick={() => { setParts([]); setNestResult(null); setStatus('idle'); setErrorMsg('') }}
                className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {parts.map((part, idx) => {
                const color = PALETTE[idx % PALETTE.length]
                const area = Math.round(polygonArea(part.points))
                return (
                  <div key={part.id} className="flex items-center gap-2 bg-slate-800 rounded px-2 py-1.5">
                    <PartPreview points={part.points} holes={part.holes} color={color} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-300 truncate">{part.label}</div>
                      <div className="text-[10px] text-slate-500">{area.toLocaleString()} mm²</div>
                    </div>
                    <button
                      onClick={() => setParts(prev => prev.filter(p => p.id !== part.id))}
                      className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="border-t border-slate-700 mx-4 my-2" />

        {/* Sheet settings */}
        <div className="px-4 pb-4 space-y-3">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Sheet</div>

          {/* Mode radio */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700">
            {(['dimensions', 'import'] as const).map((mode, i) => (
              <button
                key={mode}
                onClick={() => {
                  setSheetMode(mode)
                  if (mode === 'dimensions') clearSheetImport()
                }}
                className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${i === 0 ? '' : 'border-l border-slate-700'} ${
                  sheetMode === mode
                    ? 'bg-slate-700 text-slate-100'
                    : 'bg-slate-800/50 text-slate-500 hover:text-slate-300'
                }`}
              >
                {mode === 'dimensions' ? 'Dimensions' : 'Import sheet'}
              </button>
            ))}
          </div>

          {sheetMode === 'import' ? (
            /* Import mode */
            sheetBoundary ? (
              <div className="bg-slate-800 rounded-lg p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                    <span className="text-[11px] text-slate-300">{sheetImportInfo}</span>
                  </div>
                  <button
                    onClick={clearSheetImport}
                    className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
                  >
                    Clear
                  </button>
                </div>
                {sheetObstacles.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded bg-red-500/60 shrink-0" />
                    <span className="text-[10px] text-red-400">{sheetObstacles.length} no-cut zone{sheetObstacles.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>
            ) : (
              <div
                className="border-2 border-dashed border-slate-700 rounded-lg p-5 text-center cursor-pointer hover:border-blue-500/40 hover:bg-slate-800/30 transition-colors"
                onClick={() => sheetFileInputRef.current?.click()}
                onDrop={e => { e.preventDefault(); const f = Array.from(e.dataTransfer.files); if (f.length) handleSheetFile(f) }}
                onDragOver={e => e.preventDefault()}
              >
                <p className="text-xs text-slate-400">Drop SVG / DXF or click</p>
                <p className="text-[10px] text-slate-600 mt-1">Largest shape = boundary · others = no-cut zones</p>
              </div>
            )
          ) : (
            /* Dimensions mode */
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Width (mm)</label>
                <input
                  type="number" min="1" value={sheetConfig.width}
                  onChange={e => setSheetConfig(p => ({ ...p, width: Number(e.target.value) }))}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Height (mm)</label>
                <input
                  type="number" min="1" value={sheetConfig.height}
                  onChange={e => setSheetConfig(p => ({ ...p, height: Number(e.target.value) }))}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
                />
              </div>
            </div>
          )}
          <input
            ref={sheetFileInputRef}
            type="file"
            accept=".svg,.dxf,image/svg+xml"
            className="hidden"
            onChange={e => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) handleSheetFile(files)
              e.target.value = ''
            }}
          />

          <div className="border-t border-slate-700 -mx-0 pt-3 -mb-0">
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Layout</div>
          </div>

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Spacing (mm)</label>
            <input
              type="number" min="0" step="0.5" value={sheetConfig.spacing}
              onChange={e => setSheetConfig(p => ({ ...p, spacing: Number(e.target.value) }))}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Layout mode</label>
            <select
              value={sheetConfig.layoutMode}
              onChange={e => setSheetConfig(p => ({ ...p, layoutMode: e.target.value as LayoutMode }))}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400 appearance-none cursor-pointer"
            >
              {LAYOUT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {selectedLayout && (
              <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">{selectedLayout.desc}</p>
            )}
          </div>
        </div>

        {/* Run / Cancel buttons */}
        <div className="px-4 pb-4 flex gap-2">
          <button
            onClick={handleNest}
            disabled={parts.length === 0 || status === 'running'}
            className="flex-1 py-2 rounded bg-blue-950 hover:bg-blue-900 disabled:bg-slate-800 disabled:text-slate-600 text-blue-400 font-medium text-sm transition-colors border border-blue-500/20 disabled:border-transparent"
          >
            {status === 'running' ? 'Running…' : 'Run Nesting'}
          </button>
          {status === 'running' && (
            <button
              onClick={handleCancel}
              className="px-3 py-2 rounded bg-slate-800 hover:bg-red-950 text-slate-400 hover:text-red-400 font-medium text-sm transition-colors border border-slate-600 hover:border-red-500/30"
            >
              Cancel
            </button>
          )}
        </div>

        {/* Result */}
        {status === 'done' && nestResult && (
          <div className="px-4 pb-4 space-y-1.5">
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Result</div>
            <div className="bg-slate-800 rounded p-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Per sheet</span>
                <span className="text-slate-200 font-semibold">{nestResult.placed.length} pcs</span>
              </div>
              {labelCounts.size > 1 && (
                <div className="border-t border-slate-700 pt-2 space-y-1">
                  {Array.from(labelCounts.entries()).map(([label, count]) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-slate-400">{label}</span>
                      <span className="font-mono text-slate-200">{count} pcs</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Utilization</span>
                <span className={`font-semibold ${nestResult.efficiency >= 80 ? 'text-emerald-400' : nestResult.efficiency >= 60 ? 'text-yellow-400' : 'text-orange-400'}`}>
                  {nestResult.efficiency}%
                </span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-1">
                <div className="h-1 rounded-full bg-blue-500 transition-all" style={{ width: `${nestResult.efficiency}%` }} />
              </div>
              {wasteInfo && (
                <div className="border-t border-slate-700 pt-2 space-y-1">
                  <div className="text-slate-500 mb-1">Waste (each side)</div>
                  {([
                    { label: 'Top',    val: wasteInfo.top },
                    { label: 'Bottom', val: wasteInfo.bottom },
                    { label: 'Left',   val: wasteInfo.left },
                    { label: 'Right',  val: wasteInfo.right },
                  ]).map(({ label, val }) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-slate-400">{label}</span>
                      <span className={`font-mono ${val > 0 ? 'text-orange-400' : 'text-slate-600'}`}>
                        {val} mm
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-400">Loss area</span>
                <span className="text-slate-400">{(nestResult.lossArea / 100).toFixed(0)} cm²</span>
              </div>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="px-4 pb-4">
            <div className="bg-red-950 border border-orange-500/30 rounded p-3 text-xs text-orange-400">
              {errorMsg}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        <NestingCanvas
          result={nestResult}
          sheetConfig={sheetConfig}
          isRunning={status === 'running'}
          progress={progress}
          boundary={sheetBoundary ?? undefined}
          obstacles={sheetObstacles.length > 0 ? sheetObstacles : undefined}
          editMode={editMode}
          onEditModeChange={setEditMode}
          editablePlaced={editablePlaced}
          onPlacedChange={setEditablePlaced}
        />
      </div>
    </div>
  )
}
