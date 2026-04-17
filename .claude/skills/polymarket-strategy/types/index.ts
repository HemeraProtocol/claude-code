// Shared types for polymarket-strategy skill
// Single source of truth — imported by parser.ts, helpers.ts, and future adapters.

export type QuestionType =
  | 'above'
  | 'below'
  | 'range'
  | 'hit'
  | 'directional'
  | 'firstHit'
  | 'unknown'

export type QuestionParser = 'rules' | 'semantic'

export interface ParsedQuestion {
  questionType: QuestionType
  strike: number | null
  strike2: number | null
  parser: QuestionParser
  confidence?: number
}

export type VolWindow = '15m' | '1h' | '24h' | '7d' | '30d'

export interface SideInfo {
  index: 0 | 1
  label: string
  outcomePrice: number
  bestBid: number | null
  bestAsk: number | null
}

export interface BarrierDistanceInfo {
  currentPrice: number
  lower: number
  upper: number
  pctToLower: number
  pctToUpper: number
  logDistToLower: number
  logDistToUpper: number
}

export interface BinaryEdgeInfo {
  index: 0 | 1
  label: string
  fairPrice: number
  marketPrice: number
  edge: number
  bestBid: number | null
  bestAsk: number | null
}

export type PricingOpts = {
  sigmaWindow?: VolWindow
  sigmaOverride?: number
  simPaths?: number
  simSteps?: number
  seed?: number
}
