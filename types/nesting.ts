export interface Point { x: number; y: number }
export interface InputPolygon { id: string; label: string; points: Point[]; holes?: Point[][]; color: string; quantity: number }
export interface PlacedPart { id: string; label: string; points: Point[]; holes?: Point[][]; rotation: number; color: string }
export interface NestResult {
  placed: PlacedPart[]
  unplaced: string[]
  efficiency: number
  lossArea: number
  sheetsNeeded: number
}
export type LayoutMode = 'free' | 'same' | 'back-back' | 'chidori30' | 'chidori60'
export interface SheetConfig {
  width: number
  height: number
  spacing: number
  margin: number
  rotationStep: number
  layoutMode: LayoutMode
  boundary?: Point[]
  obstacles?: Point[][]
}
export interface SheetImportResult {
  boundary: Point[]
  obstacles: Point[][]
  width: number
  height: number
}
