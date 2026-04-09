export const RUN_STRATEGY_TOOL_NAME = 'RunStrategy'

export const DESCRIPTION = `Execute a trading strategy against live market data.
- Takes a JavaScript function body that receives \`klines\` (OHLCV candles) and returns "buy", "sell", or "hold"
- Fetches real-time kline data from Binance public API
- Runs the strategy code in a sandboxed environment
- Returns the signal, latest price, and execution metadata`
