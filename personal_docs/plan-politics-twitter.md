# Politics 市场 + Twitter 数据接入

## 当前目标

优先接入 Twitter 数据，让 politics/tweet 类 Polymarket event 能做数据分析。策略常驻运行（冻结、monitor）延后。

**做：**
- Phase 1a: `ctx.underlying` 改为可选（politics 市场能跑）
- Phase 1b: 接入 twitterapi.io，推文数据写入 `ctx.news`
- Phase 1c: SKILL.md 加 politics workflow + 策略模板
- Phase 1d: 测试

**延后：**
- 冻结策略到文件
- monitor.ts 常驻轮询
- state.json 迭代追踪

---

## 上下文

### 已完成
- 上周五 crypto 场景基础版本调好，与 Arthur 对过

### 数据源
- **twitterapi.io**：`GET https://api.twitterapi.io/twitter/user/last_tweets`
- 认证：Header `X-API-Key: $TWITTER_API_KEY`
- 参数：`userName`（或 `userId`）+ `cursor`（分页，首页传空串）
- 每页 ≤20 条，`has_next_page` + `next_cursor` 翻页
- 关键字段：`id`、`text`、`createdAt`、`author.userName`、`likeCount`、`retweetCount`、`replyCount`、`viewCount`

### Gamma API 确认
- event 和 market 对象都有 `description` 字段，包含完整 rules 文本
- rules 里包含 Twitter 账号（如 `@elonmusk`）和时间窗口（如 `April 18 12:00 PM ET to April 20, 2026 12:00 PM ET`）
- `startDate` 是 market 创建时间，**不是**推文计数起始时间——时间窗口需从 `description` 提取

### AI 驱动的数据源选择

不需要 DataSourcePlan 抽象层或独立脚本。`fetch.ts` 提供可选 CLI 参数，Claude 在 SKILL.md workflow 中根据市场问题语义决定传哪些参数：

```bash
# crypto 市场 — 需要价格数据
bun run fetch.ts --slug btc-above-100k --underlying BTC

# 推文计数类 — 需要推文数据
bun run fetch.ts --slug elon-musk-tweets --news-accounts "elonmusk" --news-since ... --news-until ...

# 政策言论类 — 需要推文内容
bun run fetch.ts --slug trump-tariffs --news-accounts "realDonaldTrump,POTUS"

# 无可编程数据源 — 纯市场价推理
bun run fetch.ts --slug will-congress-pass-bill
```

### RunJsTool 约束

`runner.ts:141-153`：`ctxPath` 和 `ctx` 是 if/else，不是 merge。因此推文数据必须写入同一个 ctx JSON 文件，不能通过 `ctx` 参数注入。这决定了 fetch.ts 必须一站式输出所有数据。

### 两阶段 fetch workflow

因为 Twitter 账号和时间窗口藏在 Gamma API 的 `description` 里，SKILL.md workflow 需要两阶段：

1. **第一次 fetch**（轻量）：`fetch.ts --slug X` → 拿市场结构 + description
2. **Claude 读 description** → 提取 Twitter 账号（`@elonmusk`）+ 时间窗口
3. **第二次 fetch**（完整）：`fetch.ts --slug X --news-accounts elonmusk --news-since ... --news-until ...` → 拉推文写入 ctx

---

## Phase 1a: `ctx.underlying` 改为可选

| 文件 | 改动 |
|------|------|
| `types/index.ts:98-109` | `underlying` → `underlying?` |
| `adapters/live.ts:84-92` | 默认值 `'BTC'` → `undefined`；Binance fetch 包在 `if (underlying)` 里 |
| `fetch.ts:45` | 移除 `?? 'BTC'` |
| `helpers.ts:106` | `resolveVolAndTime` 顶部加 `if (!ctx.underlying) throw`（一个 guard 覆盖全部 BS 函数） |

不改：
- `parser.ts` — politics 问题 fall 到 `unknown` 是正确行为
- `outcomeSides/yesSide/edgeFromProbs/binaryProbsFromYesProb` — 不依赖 underlying
- `RunJsTool` — 通用执行器，不关心市场类型

---

## Phase 1b: twitterapi.io 接入 + ctx.news

### 类型定义

```typescript
// types/index.ts 新增
export interface TweetData {
  author: string      // handle, e.g. "elonmusk"
  text: string
  createdAt: string   // "Tue Dec 10 07:00:30 +0000 2024"
}

export interface NewsData {
  tweets: TweetData[]   // 最新 20 条，按时间倒序，只保留 author/text/createdAt
  totalCount: number    // 时间窗口内总发推数（翻页聚合）
  fetchedAt: string
  accounts: string[]
}

// Ctx 新增
export interface Ctx {
  event: { slug: string; title: string; description?: string }
  markets: MarketData[]
  underlying?: { ... }  // 已改为可选
  news?: NewsData       // 新增
  timing: { nowTs: number }
}

// BuildCtxOpts 新增
export interface BuildCtxOpts {
  underlying?: string
  klineLimit?: number
  newsAccounts?: string[]
  newsSince?: string    // ISO timestamp，翻页截止下界
  newsUntil?: string    // ISO timestamp，翻页截止上界
}
```

### GammaMarket / GammaEvent 补字段

```typescript
// adapters/live.ts — 内部类型
interface GammaMarket {
  // ...existing fields...
  description?: string   // 新增：rules 文本
}
interface GammaEvent {
  // ...existing fields...
  description?: string   // 新增：event 级 rules
}
```

### LiveAdapter 改动

```typescript
// adapters/live.ts

async buildCtx(slug: string, opts?: BuildCtxOpts): Promise<Ctx> {
  const underlying = opts?.underlying?.toUpperCase() || undefined

  // Gamma 总是拉
  const event = await this.fetchGammaEvent(slug)

  // Binance 只在有 underlying 时拉
  let underlyingData: Ctx['underlying'] = undefined
  if (underlying) {
    const [klines1h, volResult] = await Promise.all([
      this.fetchBinanceKlines(underlying, '1h', klineLimit),
      this.realizedVolByWindow(underlying),
    ])
    underlyingData = { symbol: underlying, price: ..., klines: klines1h, ... }
  }

  // Twitter 只在有 newsAccounts 时拉
  let newsData: NewsData | undefined = undefined
  if (opts?.newsAccounts?.length) {
    newsData = await this.fetchTweets(opts.newsAccounts, opts.newsSince, opts.newsUntil)
  }

  // ...orderbook fetch 不变...

  return {
    event: { slug: event.slug, title: event.title, description: event.description },
    markets,
    underlying: underlyingData,
    news: newsData,
    timing: { nowTs: Date.now() },
  }
}
```

### fetchTweets 实现

```typescript
private async fetchTweets(
  accounts: string[],
  since?: string,
  until?: string,
): Promise<NewsData> {
  const sinceTs = since ? new Date(since).getTime() : 0
  const untilTs = until ? new Date(until).getTime() : Infinity
  const recentTweets: TweetData[] = []
  let totalCount = 0

  for (const userName of accounts) {
    let cursor = ''
    let done = false
    while (!done) {
      const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${userName}&cursor=${cursor}`
      const res = await fetch(url, { headers: { 'X-API-Key': process.env.TWITTER_API_KEY! } })
      if (!res.ok) break
      const data = await res.json()
      for (const t of data.tweets ?? []) {
        const ts = new Date(t.createdAt).getTime()
        if (ts < sinceTs) { done = true; break }
        if (ts > untilTs) continue
        totalCount++
        if (recentTweets.length < 20) {
          recentTweets.push({
            author: t.author.userName,
            text: t.text,
            createdAt: t.createdAt,
          })
        }
      }
      if (!data.has_next_page || done) break
      cursor = data.next_cursor
    }
  }

  return {
    tweets: recentTweets,
    totalCount,
    fetchedAt: new Date().toISOString(),
    accounts,
  }
}
```

### fetch.ts CLI 参数

```typescript
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    slug: { type: 'string' },
    underlying: { type: 'string' },
    limit: { type: 'string' },
    'news-accounts': { type: 'string' },  // 新增：逗号分隔
    'news-since': { type: 'string' },     // 新增：ISO timestamp
    'news-until': { type: 'string' },     // 新增：ISO timestamp
  },
  strict: true,
})

const ctx = await adapter.buildCtx(slug, {
  underlying: values.underlying,  // 不再默认 'BTC'
  klineLimit: ...,
  newsAccounts: values['news-accounts']?.split(',').map(s => s.trim()),
  newsSince: values['news-since'],
  newsUntil: values['news-until'],
})
```

---

## Phase 1c: SKILL.md 更新

### Workflow 改动

Step 1-2 改为：

1. **Extract slug** from user input.
2. **First fetch（市场结构）**：`bun run fetch.ts --slug <slug>`
   - 读 stdout JSON 拿 `ctxPath`
   - 读 ctx 文件中的 `event.description` 和 `markets[].question`
3. **AI 决定数据源**：根据市场问题语义判断：
   - 问题涉及 crypto 价格 → 识别 ticker → 准备 `--underlying BTC`
   - 问题涉及推文计数/特定人物言论 → 从 description 提取账号 + 时间窗口 → 准备 `--news-accounts` + `--news-since/until`
   - 无可编程数据源 → 不加额外参数
4. **Second fetch（完整数据）**：带上决定好的参数重新调 `fetch.ts`
5. **Compose strategy** → run_js → 报告

### ctx Schema 补充

```
ctx.event
  .description    string|undefined  — event rules 文本（含时间窗口、账号等信息）

ctx.news                            — 推文数据（仅当 --news-accounts 传入时存在）
  .tweets[]                         — 最新 20 条，按时间倒序
    .author       string            — Twitter handle
    .text         string
    .createdAt    string
  .totalCount     number            — 时间窗口内总发推数
  .fetchedAt      string
  .accounts       string[]

ctx.underlying                      — 可选，仅 crypto 市场
  （schema 不变，标注为可选）
```

### 新增 Politics 策略指导

- `ctx.underlying` 为 undefined 时，所有 BS 定价和 vol helper 不可用（会 throw）
- **不要调用 `eventPrimaryQuestionType`** — politics 事件全是 `questionType: 'unknown'`，该函数会 throw
- 推文计数类市场：直接用 `ctx.news.totalCount` 对比市场问题里的阈值
- 内容分析类市场：LLM 读 `ctx.news.tweets` 文本 → 估计 `pYes` → `edgeFromProbs` 出信号
- 无数据源市场：LLM 基于市场价格 + 问题语义推理，输出低置信度信号

### 新增 Politics Strategy Template

```js
// Politics/Tweet 事件模板
// 不使用 BS 定价、不依赖 ctx.underlying
// LLM 在生成策略时根据 ctx.news 和问题语义填入概率估计

const THRESHOLD = 0.04;

// LLM: 根据 ctx.news.tweets 内容和 ctx.news.totalCount 填入每个市场的概率估计
const estimates = {
  // "Will Elon Musk post <40 tweets...": pYes 基于 totalCount 外推
  // "Will Elon Musk post 40-59 tweets...": pYes 基于 totalCount + 发推速率
};

return ctx.markets.map((market) => {
  try {
    if (market.closed || market.hoursToExpiry < 0) {
      return { question: market.question, decision: "hold", reason: "closed or expired" };
    }
    const mCtx = { market, timing: ctx.timing };
    const pYes = estimates[market.question] ?? 0.5;
    const probs = ctx.helpers.binaryProbsFromYesProb(mCtx, pYes);
    const edges = ctx.helpers.edgeFromProbs(probs, mCtx);
    const best = edges[0].edge >= edges[1].edge ? edges[0] : edges[1];
    if (best.edge < THRESHOLD) {
      return { question: market.question, decision: "hold", edge: best.edge, pYes };
    }
    return {
      question: market.question,
      decision: "buy",
      side: best.label,
      fairPrice: best.fairPrice,
      marketPrice: best.marketPrice,
      edge: best.edge,
      pYes,
    };
  } catch (err) {
    return { question: market.question, decision: "hold", reason: String(err) };
  }
});
```

---

## Phase 1d: 测试

### adapters.test.ts 新增
- 无 `underlying` → `ctx.underlying` 为 undefined，不调 Binance
- 有 `underlying` → 行为不变（回归）
- 有 `newsAccounts` → `ctx.news` 包含 tweets + totalCount
- 无 `newsAccounts` → `ctx.news` 为 undefined

### helpers.test.ts 新增
- `resolveVolAndTime` 在 `ctx.underlying` 为 undefined 时 throw
- BS 函数（bsAbove/bsRange/bsOneTouch）在无 underlying 时 throw（被 resolveVolAndTime guard 覆盖）
- `edgeFromProbs`/`outcomeSides`/`binaryProbsFromYesProb` 不依赖 underlying，正常工作

---

## 回归验证

- `bun run fetch.ts --slug bitcoin-above-april-17 --underlying BTC` → crypto 行为不变
- `bun test .claude/skills/polymarket-strategy/__tests__/` → 全过

---

## 延后事项

| 事项 | 原因 |
|------|------|
| 冻结策略到文件 | 优先做分析能力 |
| monitor.ts 常驻轮询 | 依赖冻结；politics 策略的 LLM 估计值是静态的，monitor 重执行不更新概率 |
| state.json 迭代追踪 | 依赖 monitor |
| 回测引擎 | 需要 ctx 持久化 + 市场结算数据 |
| 前端界面 | clone repo → 本地跑 |
| 自动交易 | Pro trader 不会把 credential 给第三方 |

---

## 关键文件清单

**修改：**
- `.claude/skills/polymarket-strategy/types/index.ts` — Ctx 类型可选化 + TweetData/NewsData/BuildCtxOpts
- `.claude/skills/polymarket-strategy/adapters/live.ts` — underlying/news 条件化 + fetchTweets + GammaEvent.description
- `.claude/skills/polymarket-strategy/fetch.ts` — 移除 BTC 默认 + news 参数
- `.claude/skills/polymarket-strategy/helpers.ts` — resolveVolAndTime guard
- `.claude/skills/polymarket-strategy/SKILL.md` — 两阶段 workflow + politics 模板 + ctx.news schema
- `.claude/skills/polymarket-strategy/__tests__/*.test.ts` — 新增 politics 测试
