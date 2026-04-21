// Shared types for polymarket-strategy skill
// Single source of truth — imported by parser.ts, helpers.ts, and future adapters.

export type QuestionType =
  | 'above'
  | 'below'
  | 'range'
  | 'hit'
  | 'directional'
  | 'firstHit'
  | 'count'
  | 'unknown'

export interface CountModel {
  mu: number
  sigma: number
  rate: number
  elapsed: number
  remaining: number
}

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

// ─── ctx shape ──────────────────────────────────────────────────────────────

export interface Kline {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface OutcomeData {
  label: string
  price: number
  bestBid: number | null
  bestAsk: number | null
}

export interface MarketData {
  slug: string
  question: string
  questionType: QuestionType
  kind: 'absolute' | 'directional'
  strike: number | null
  strike2: number | null
  parser: QuestionParser
  confidence: number
  expiryDate: string
  expiryTs: number
  hoursToExpiry: number
  outcomes: OutcomeData[]
  volume: number
  liquidity: number
  active: boolean
  closed: boolean
}

export interface TweetData {
  author: string
  text: string
  createdAt: string
}

export interface NewsData {
  tweets: TweetData[]
  totalCount: number
  fetchedAt: string
  accounts: string[]
}

export interface Ctx {
  event: { slug: string; title: string; description?: string }
  markets: MarketData[]
  underlying?: {
    symbol: string
    price: number
    klines: Kline[]
    realizedVol: Record<string, number>
    realizedVolWarnings: string[]
  }
  news?: NewsData
  timing: { nowTs: number }
}

// ─── adapter ────────────────────────────────────────────────────────────────

export interface BuildCtxOpts {
  underlying?: string
  klineLimit?: number
  newsAccounts?: string[]
  newsSince?: string
  newsUntil?: string
}

export interface DataAdapter {
  buildCtx(slug: string, opts?: BuildCtxOpts): Promise<Ctx>
}
