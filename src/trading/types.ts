export interface KlineData {
  open: number
  high: number
  low: number
  close: number
  volume: number
  timestamp: number
}

export type Signal = 'buy' | 'sell' | 'hold'
