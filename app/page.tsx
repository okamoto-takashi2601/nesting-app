'use client'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import NestingCanvas from '@/components/NestingCanvas'
import { parseFile, parseFileForSheet } from '@/lib/svgParser'
import { polygonArea } from '@/lib/geometry'
import { LANGS, makeTFunc } from '@/lib/i18n'
import type { Lang, TFunc } from '@/lib/i18n'
import type { InputPolygon, NestResult, SheetConfig, LayoutMode, Point, PlacedPart } from '@/types/nesting'

const PALETTE = ['#4f8ef7', '#4fcf8e', '#f7c34f', '#f77f4f', '#cf4ff7', '#4ff7e8']

const SHEET_STORAGE_KEY = 'nesting-sheet-config'

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
    width: 297,
    height: 210,
    spacing: 5,
    margin: 5,
    rotationStep: 1,
    layoutMode: 'same',
  })
  const [lang, setLang] = useState<Lang>('en')
  const [showLangMenu, setShowLangMenu] = useState(false)
  const langMenuRef = useRef<HTMLDivElement>(null)
  const t: TFunc = useMemo(() => makeTFunc(lang), [lang])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SHEET_STORAGE_KEY)
      if (saved) {
        const p = JSON.parse(saved)
        setSheetConfig(prev => ({
          ...prev,
          ...(typeof p.width === 'number' && { width: p.width }),
          ...(typeof p.height === 'number' && { height: p.height }),
          ...(typeof p.spacing === 'number' && { spacing: p.spacing }),
          ...(typeof p.margin === 'number' && { margin: p.margin }),
          ...(typeof p.layoutMode === 'string' && { layoutMode: p.layoutMode }),
        }))
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (!showLangMenu) return
    function handleClick(e: MouseEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node))
        setShowLangMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showLangMenu])

  const layoutOptions = useMemo(() => [
    { value: 'same'     , label: t('sameDirection'), desc: t('sameDirectionDesc')  },
    { value: 'back-back', label: t('backToBack'),    desc: t('backToBackDesc')     },
    { value: 'interlock', label: t('interlockMode'), desc: t('interlockModeDesc')  },
    { value: 'square'   , label: t('squareLayout'),  desc: t('squareLayoutDesc')   },
    { value: 'chidori30', label: t('chidori30'),     desc: t('chidori30Desc')      },
    { value: 'chidori60', label: t('chidori60'),     desc: t('chidori60Desc')      },
    { value: 'free'     , label: t('freeRotation'),  desc: t('freeRotationDesc')   },
  ], [t])

  const [nestResult, setNestResult] = useState<NestResult | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editablePlaced, setEditablePlaced] = useState<PlacedPart[]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const isReNestingRef = useRef(false)
  const lockedPartsRef = useRef<PlacedPart[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sheetFileInputRef = useRef<HTMLInputElement>(null)
  const layoutHelpRef = useRef<HTMLSpanElement>(null)
  const [layoutTooltipPos, setLayoutTooltipPos] = useState<{ x: number; y: number } | null>(null)

  // Parts input mode
  const [partsMode, setPartsMode] = useState<'quick' | 'import'>('import')

  // Sheet shape import state
  const [sheetMode, setSheetMode] = useState<'import' | 'dimensions'>('dimensions')
  const [sheetBoundary, setSheetBoundary] = useState<Point[] | null>(null)
  const [sheetObstacles, setSheetObstacles] = useState<Point[][]>([])
  const [sheetImportInfo, setSheetImportInfo] = useState<number>(0)

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

  const activePartsCount = useMemo(() => parts.filter(p => p.enabled !== false).length, [parts])

  useEffect(() => {
    if (activePartsCount > 1) {
      setSheetConfig(p => p.layoutMode === 'free' ? p : { ...p, layoutMode: 'free' })
    }
  }, [activePartsCount])

  useEffect(() => {
    workerRef.current = new Worker('/workers/nesting.worker.js')
    workerRef.current.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'progress') {
        setNestResult(prev => ({ placed: e.data.placed, unplaced: prev?.unplaced ?? [], efficiency: prev?.efficiency ?? 0, lossArea: prev?.lossArea ?? 0, sheetsNeeded: prev?.sheetsNeeded ?? 0 }))
        setProgress({ current: e.data.current, total: e.data.total })
      } else if (e.data.type === 'result') {
        const newPlaced = isReNestingRef.current
          ? [...lockedPartsRef.current, ...e.data.placed]
          : e.data.placed
        isReNestingRef.current = false
        setNestResult({ placed: newPlaced, unplaced: e.data.unplaced, efficiency: e.data.efficiency, lossArea: e.data.lossArea, sheetsNeeded: e.data.sheetsNeeded })
        setEditablePlaced(newPlaced)
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
      return n.endsWith('.svg') || n.endsWith('.dxf') || n.endsWith('.igs') || n.endsWith('.iges') || n.endsWith('.pdf') || f.type === 'image/svg+xml'
    })
    if (valid.length === 0) {
      setErrorMsg(t('errInvalidFile'))
      setStatus('error')
      return
    }
    try {
      const results = await Promise.all(valid.map(f => parseFile(f)))
      const allParsed = results.flat()
      if (allParsed.length === 0) {
        setErrorMsg(t('errNoShapes'))
        setStatus('error')
        return
      }
      setParts(prev => [...prev, ...allParsed])
      setNestResult(null)
      setStatus('idle')
      setErrorMsg('')
    } catch {
      setErrorMsg(t('errParseFail'))
      setStatus('error')
    }
  }, [t])

  const handleSheetFile = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    try {
      const result = await parseFileForSheet(file)
      if (!result) {
        setErrorMsg(t('errNoSheetShapes'))
        setStatus('error')
        return
      }
      setSheetBoundary(result.boundary)
      setSheetObstacles(result.obstacles)
      setSheetImportInfo(result.obstacles.length)
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
      setErrorMsg(t('errSheetParseFail'))
      setStatus('error')
    }
  }, [t])

  function clearSheetImport() {
    setSheetBoundary(null)
    setSheetObstacles([])
    setSheetImportInfo(0)
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
        const newPlaced = isReNestingRef.current
          ? [...lockedPartsRef.current, ...e.data.placed]
          : e.data.placed
        isReNestingRef.current = false
        setNestResult({ placed: newPlaced, unplaced: e.data.unplaced, efficiency: e.data.efficiency, lossArea: e.data.lossArea, sheetsNeeded: e.data.sheetsNeeded })
        setEditablePlaced(newPlaced)
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
    try {
      localStorage.setItem(SHEET_STORAGE_KEY, JSON.stringify({
        width: sheetConfig.width,
        height: sheetConfig.height,
        spacing: sheetConfig.spacing,
        margin: sheetConfig.margin,
        layoutMode: sheetConfig.layoutMode,
      }))
    } catch {}
    setStatus('running')
    setNestResult(null)
    setProgress(null)
    const sheetArea = sheetConfig.width * sheetConfig.height
    const activeParts = parts.filter(p => p.enabled !== false)
    let expanded: InputPolygon[]
    let setSize = 0
    const useSetMode = activeParts.some(p => (p.quantity || 1) > 1)
    if (useSetMode) {
      const setTemplate = activeParts.flatMap(p =>
        Array.from({ length: Math.max(1, p.quantity || 1) }, () => p)
      )
      setSize = setTemplate.length
      const totalSetArea = setTemplate.reduce((sum, p) => sum + polygonArea(p.points), 0)
      const setsK = totalSetArea > 0 ? Math.min(Math.ceil(sheetArea / totalSetArea) + 5, 500) : 10
      expanded = Array.from({ length: setsK }, (_, setIdx) =>
        setTemplate.map((p, pos) => ({ ...p, id: `${p.id}-s${setIdx}-${pos}` }))
      ).flat()
    } else {
      expanded = activeParts.flatMap(p => {
        const area = polygonArea(p.points)
        const maxQty = area > 0 ? Math.min(Math.ceil(sheetArea / area) + 5, 2000) : 200
        return Array.from({ length: maxQty }, (_, i) => ({ ...p, id: `${p.id}-${i}` }))
      })
    }
    const configWithShape: SheetConfig = {
      ...sheetConfig,
      boundary: sheetBoundary ?? undefined,
      obstacles: sheetObstacles.length > 0 ? sheetObstacles : undefined,
    }
    workerRef.current.postMessage({ polygons: expanded, sheetConfig: configWithShape, setSize })
  }, [parts, activePartsCount, sheetConfig, sheetBoundary, sheetObstacles])

  const handleReNest = useCallback(() => {
    if (!workerRef.current || editablePlaced.length === 0) return
    const locked = editablePlaced.filter(p => p.locked)
    const free = editablePlaced.filter(p => !p.locked)
    if (free.length === 0) return
    lockedPartsRef.current = locked
    isReNestingRef.current = true
    setStatus('running')
    setProgress(null)
    const polygonsForWorker = free.map(p => ({
      id: p.id,
      label: p.label,
      color: p.color,
      quantity: 1,
      points: p.points,
      holes: p.holes,
    }))
    const configWithShape: SheetConfig = {
      ...sheetConfig,
      boundary: sheetBoundary ?? undefined,
      obstacles: sheetObstacles.length > 0 ? sheetObstacles : undefined,
    }
    workerRef.current.postMessage({
      polygons: polygonsForWorker,
      sheetConfig: configWithShape,
      lockedParts: locked,
    })
  }, [editablePlaced, sheetConfig, sheetBoundary, sheetObstacles])

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div
        className="w-72 shrink-0 flex flex-col bg-slate-900 border-r border-slate-700 overflow-hidden"
      >
        {/* Fixed top: header + parts input */}
        <div className="shrink-0 flex flex-col">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold text-slate-200">{t('appName')}</h1>
            <div className="relative" ref={langMenuRef}>
              <button
                onClick={() => setShowLangMenu(v => !v)}
                className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                title="Language"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
              </button>
              {showLangMenu && (
                <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 py-1 min-w-[80px]">
                  {LANGS.map(l => (
                    <button key={l.code}
                      onClick={() => { setLang(l.code); setShowLangMenu(false) }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        lang === l.code ? 'text-blue-400 font-medium' : 'text-slate-300 hover:text-slate-100 hover:bg-slate-700'
                      }`}>
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <p className="text-[10px] text-slate-600 mt-0.5">{t('appBy')}</p>
        </div>

        {/* Parts section */}
        <div className="px-4 pb-3 pt-4">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-2">{t('parts')}</div>

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
                {mode === 'quick' ? t('quickShapes') : t('importParts')}
              </button>
            ))}
          </div>

          {partsMode === 'quick' ? (
            <>
              {/* Shape type selector */}
              <div className="flex gap-1 mb-3">
                {([
                  { type: 'circle'  , icon: <circle cx="7" cy="7" r="5.5"/>,                      labelKey: 'circle'   },
                  { type: 'rect'    , icon: <rect x="1.5" y="3" width="11" height="8" rx="0.5"/>, labelKey: 'rect'     },
                  { type: 'triangle', icon: <polygon points="7,1.5 13,12.5 1,12.5"/>,             labelKey: 'triangle' },
                ] as { type: ShapeType; icon: React.ReactNode; labelKey: string }[]).map(s => (
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
                    {t(s.labelKey)}
                  </button>
                ))}
              </div>

              {/* Dimension inputs */}
              <div className="bg-slate-800 rounded-lg p-2.5 space-y-2">
                {shapeType === 'circle' && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500 shrink-0">{t('diameter')}</span>
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
                  {t(shapeType === 'circle' ? 'addCircle' : shapeType === 'rect' ? 'addRectangle' : 'addTriangle')}
                </button>
              </div>
            </>
          ) : (
            /* Import parts */
            <>
              <div className="relative">
                <div
                  className="border-2 border-dashed border-slate-700 rounded-lg p-5 text-center cursor-pointer hover:border-blue-500/40 hover:bg-slate-800/30 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={e => { e.preventDefault(); const f = Array.from(e.dataTransfer.files); if (f.length) handleFiles(f) }}
                  onDragOver={e => e.preventDefault()}
                >
                  <p className="text-xs text-slate-400">{t('dropPartsHint')}</p>
                  <p className="text-[10px] text-slate-600 mt-1">{t('multipleFilesSupported')}</p>
                </div>
                <div className="absolute top-2 right-2 group" onClick={e => e.stopPropagation()}>
                  <span className="w-4 h-4 rounded-full bg-slate-700 hover:bg-slate-600 text-slate-400 text-[9px] flex items-center justify-center cursor-default select-none transition-colors">?</span>
                  <div className="absolute bottom-full right-0 mb-1.5 hidden group-hover:block z-50 pointer-events-none w-52">
                    <div className="bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-2 text-[10px] text-slate-300 leading-relaxed shadow-xl whitespace-pre-line">
                      {t('importHints')}
                    </div>
                  </div>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg,.dxf,.igs,.iges,.pdf,image/svg+xml"
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

        </div>{/* end fixed top */}

        {/* Parts list — only this section scrolls */}
        {parts.length > 0 && (
          <div className="flex flex-col border-t border-slate-700 min-h-0 max-h-[35vh]">
            <div className="shrink-0 flex items-center justify-between px-4 py-2">
              <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                {t('partsCount', { n: parts.length })}
              </span>
              <button
                onClick={() => { setParts([]); setNestResult(null); setStatus('idle'); setErrorMsg('') }}
                className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
              >
                {t('clearAll')}
              </button>
            </div>
            <div className="overflow-y-auto min-h-0 px-4 pb-2 space-y-1">
              {parts.map((part, idx) => {
                const enabled = part.enabled !== false
                const color = PALETTE[idx % PALETTE.length]
                const area = Math.round(polygonArea(part.points))
                return (
                  <div key={part.id} className={`flex items-center gap-2 bg-slate-800 rounded px-2 py-1.5 ${enabled ? '' : 'opacity-40'}`}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={e => setParts(prev => prev.map(p => p.id === part.id ? { ...p, enabled: e.target.checked } : p))}
                      className="shrink-0 w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 accent-blue-500 cursor-pointer"
                    />
                    <PartPreview points={part.points} holes={part.holes} color={color} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-300 truncate">{part.label}</div>
                      <div className="text-[10px] text-slate-500">{area.toLocaleString()} mm²</div>
                    </div>
                    <div className="relative group shrink-0">
                      <div className="flex items-center gap-0.5">
                        <span className="text-[10px] text-slate-500">×</span>
                        <input
                          type="number" min="1" max="99"
                          value={part.quantity}
                          onChange={e => setParts(prev => prev.map(p =>
                            p.id === part.id ? { ...p, quantity: Math.max(1, parseInt(e.target.value) || 1) } : p
                          ))}
                          className="w-8 bg-slate-700 border border-slate-600 rounded px-1 py-0.5 text-xs text-slate-200 text-center focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </div>
                      <div className="absolute bottom-full right-0 mb-1 hidden group-hover:block z-50 pointer-events-none">
                        <div className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[10px] text-slate-300 whitespace-nowrap shadow-xl">
                          {t('pcsPerSet')}
                        </div>
                      </div>
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

        {/* Sheet settings + buttons */}
        <div className="shrink-0 border-t border-slate-700 overflow-y-auto max-h-[60vh]">

        {/* Sheet settings */}
        <div className="px-4 pt-4 pb-4 space-y-3">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">{t('sheet')}</div>

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
                {mode === 'dimensions' ? t('dimensions') : t('importSheet')}
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
                    <span className="text-[11px] text-slate-300">{sheetConfig.width} × {sheetConfig.height} mm</span>
                  </div>
                  <button
                    onClick={clearSheetImport}
                    className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {t('clear')}
                  </button>
                </div>
                {sheetImportInfo > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded bg-red-500/60 shrink-0" />
                    <span className="text-[10px] text-red-400">{t('noCutZones', { n: sheetImportInfo })}</span>
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
                <p className="text-xs text-slate-400">{t('dropSheetHint')}</p>
                <p className="text-[10px] text-slate-600 mt-1">{t('sheetHintSub')}</p>
              </div>
            )
          ) : (
            /* Dimensions mode */
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">{t('width')}</label>
                <input
                  type="number" min="1" value={sheetConfig.width}
                  onChange={e => setSheetConfig(p => ({ ...p, width: Number(e.target.value) }))}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">{t('height')}</label>
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
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">{t('layout')}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex items-center gap-1 mb-1">
                <label className="text-[11px] text-slate-400">{t('spacing')}</label>
                <div className="relative group">
                  <span className="w-3.5 h-3.5 rounded-full bg-slate-700 text-slate-500 text-[9px] flex items-center justify-center cursor-default select-none">?</span>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50 pointer-events-none w-40">
                    <div className="bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-2 text-[10px] text-slate-300 leading-relaxed shadow-xl">
                      {t('spacingTooltip')}
                    </div>
                  </div>
                </div>
              </div>
              <input
                type="number" min="0" step="0.5" value={sheetConfig.spacing}
                onChange={e => setSheetConfig(p => ({ ...p, spacing: Number(e.target.value) }))}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <div className="flex items-center gap-1 mb-1">
                <label className="text-[11px] text-slate-400">{t('margin')}</label>
                <div className="relative group">
                  <span className="w-3.5 h-3.5 rounded-full bg-slate-700 text-slate-500 text-[9px] flex items-center justify-center cursor-default select-none">?</span>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50 pointer-events-none w-40">
                    <div className="bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-2 text-[10px] text-slate-300 leading-relaxed shadow-xl">
                      {t('marginTooltip')}
                    </div>
                  </div>
                </div>
              </div>
              <input
                type="number" min="0" step="0.5" value={sheetConfig.margin}
                onChange={e => setSheetConfig(p => ({ ...p, margin: Number(e.target.value) }))}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400"
              />
            </div>
          </div>

          {activePartsCount <= 1 && (
          <div>
            <div className="flex items-center gap-1 mb-1">
              <label className="text-[11px] text-slate-400">{t('layoutMode')}</label>
              <span
                ref={layoutHelpRef}
                className="w-3.5 h-3.5 rounded-full bg-slate-700 text-slate-500 text-[9px] flex items-center justify-center cursor-default select-none"
                onMouseEnter={() => {
                  const r = layoutHelpRef.current?.getBoundingClientRect()
                  if (r) setLayoutTooltipPos({ x: r.left, y: r.top })
                }}
                onMouseLeave={() => setLayoutTooltipPos(null)}
              >?</span>
            </div>
            <select
              value={sheetConfig.layoutMode}
              onChange={e => setSheetConfig(p => ({ ...p, layoutMode: e.target.value as LayoutMode }))}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-400 appearance-none cursor-pointer"
            >
              {layoutOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          )}
        </div>

        {/* Run / Cancel buttons */}
        <div className="px-4 pb-4 flex gap-2">
          <button
            onClick={handleNest}
            disabled={parts.filter(p => p.enabled !== false).length === 0 || status === 'running'}
            className="flex-1 py-2 rounded bg-blue-950 hover:bg-blue-900 disabled:bg-slate-800 disabled:text-slate-600 text-blue-400 font-medium text-sm transition-colors border border-blue-500/20 disabled:border-transparent"
          >
            {status === 'running' ? t('running') : t('runNesting')}
          </button>
          {status === 'running' && (
            <button
              onClick={handleCancel}
              className="px-3 py-2 rounded bg-slate-800 hover:bg-red-950 text-slate-400 hover:text-red-400 font-medium text-sm transition-colors border border-slate-600 hover:border-red-500/30"
            >
              {t('cancel')}
            </button>
          )}
        </div>

        {/* Re-nest button — shown in edit mode when free parts exist */}
        {editMode && editablePlaced.some(p => !p.locked) && (
          <div className="px-4 pb-4">
            <button
              onClick={handleReNest}
              disabled={status === 'running'}
              title={t('reNestTitle')}
              className="w-full py-2 rounded bg-amber-950 hover:bg-amber-900 disabled:bg-slate-800 disabled:text-slate-600 text-amber-400 font-medium text-sm transition-colors border border-amber-500/20 disabled:border-transparent"
            >
              {t('reNestFree')}
            </button>
          </div>
        )}

        {/* Result */}
        {status === 'error' && (
          <div className="px-4 pb-4">
            <div className="bg-red-950 border border-orange-500/30 rounded p-3 text-xs text-orange-400">
              {errorMsg}
            </div>
          </div>
        )}
        </div>{/* end fixed bottom */}
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
          t={t}
        />
      </div>

      {layoutTooltipPos && (
        <div
          className="fixed z-50 pointer-events-none w-56"
          style={{ left: layoutTooltipPos.x, bottom: window.innerHeight - layoutTooltipPos.y + 8 }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-2 shadow-xl">
            {layoutOptions.map(opt => (
              <div key={opt.value} className="mb-1.5 last:mb-0">
                <div className="text-[10px] font-medium text-slate-300">{opt.label}</div>
                <div className="text-[10px] text-slate-500">{opt.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
