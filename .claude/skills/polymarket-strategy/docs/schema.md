# ctx Schema Reference

```
ctx.event
  .slug           string          — event slug (user usually provides this)
  .title          string          — event title shown in Polymarket UI
  .description    string|undefined — event rules text (contains time windows, accounts, resolution rules)

ctx.markets[]                     — all markets under the event (one per price level)
  .slug           string
  .question       string          — e.g. "Will BTC be above $95,000 on Jan 1?"
  .questionType   'above'|'below'|'range'|'hit'|'directional'|'firstHit'|'count'|'unknown'
                                  — semantic type parsed from question text
                                  — 'count' = tweet/post count markets ("post 80-99 tweets")
  .kind           'absolute'|'directional'
                                  — legacy field; use questionType for new code
  .strike         number|null     — lower (or only) strike; null for directional
  .strike2        number|null     — upper strike for range/firstHit/count markets; null for count "N+" (open-ended)
  .parser         'rules'         — current parser implementation
  .confidence     number          — parser confidence (1 for rules matches, 0 for unknown)
  .expiryDate     string          — ISO date
  .expiryTs       number          — epoch ms
  .hoursToExpiry  number
  .outcomes[]
    .label        string          — e.g. "Yes"/"No", "Up"/"Down", "$60k"/"$80k"
    .price        number          — current market price (0–1)
    .bestBid      number|null
    .bestAsk      number|null
  .volume         number
  .liquidity      number
  .active         boolean
  .closed         boolean

ctx.underlying                    — OPTIONAL: only present when --underlying is passed (crypto markets)
  .symbol         string          — "BTC", "ETH", etc.
  .price          number          — latest 1h-close price in USD
  .klines[]                       — up to 200 hourly candles (default; use --limit to adjust)
    .timestamp    number
    .open/high/low/close number
    .volume       number
  .realizedVol                    — annualized realized vol
    ['15m']       number
    ['1h']        number
    ['24h']       number
    ['7d']        number
    ['30d']       number
  .realizedVolWarnings  string[]  — non-empty if any vol window failed; empty = all OK

ctx.news                          — OPTIONAL: only present when --news-accounts is passed
  .tweets[]                       — up to 20 most recent tweets (within time window), newest first
    .author       string          — Twitter handle (e.g. "elonmusk")
    .text         string          — tweet content
    .createdAt    string          — e.g. "Tue Dec 10 07:00:30 +0000 2024"
  .totalCount     number          — total tweets in the time window (paginated count)
  .fetchedAt      string          — ISO timestamp of when tweets were fetched
  .accounts       string[]        — accounts that were queried

ctx.timing
  .nowTs          number          — epoch ms (captured at fetch time)

ctx.warnings      string[]|undefined — non-empty if any data source had issues (empty book, fetch failures, vol warnings)
```
