# Polymarket Strategy Framework — 架构文档

> 版本: v0.1 | 日期: 2026-04-17 | 分支: feat/polymarket-strategy

## 1. 系统概述

### 什么是「策略」

一个策略是一段 **纯函数 JavaScript 代码**（40–80 行），接收结构化市场上下文 `ctx`，返回一个信号数组：

```
f(ctx) → [{question, decision, side?, edge?, ...}, ...]
```

策略不做 I/O、不导入模块、不维护状态。所有外部数据（行情、波动率、订单簿）在执行前已注入 `ctx`；常用的定价和特征计算原语通过 `ctx.helpers` 提供，策略代码可自由编写内联逻辑（局部变量、`Math.*`、自定义函数等），只是无法 `import` 外部模块。这种设计确保：

- **可复现**: 同一 ctx + 同一代码 → 同一结果
- **可审计**: 每次执行产生带 SHA256 签名的日志
- **可回测**: ctx 可序列化保存，未来回放

### 系统定位

```
Polymarket API ──┐
CLOB API      ──┤
Binance API   ──┤──→ [ 数据层 ] ──→ ctx.json ──→ [ 策略执行 ] ──→ 信号数组
News API (planned)┤     多源获取        ↑            run_js tool
Event API (planned)┘    组装 ctx    ctx schema = 契约
```

这是一个 **信号生成系统**，不负责下单执行。输出是「买哪边 / 不动」的决策建议，附带 edge 和概率。

**ctx schema 是数据层和策略层之间的唯一契约。** 策略代码（LLM 生成）不关心数据从哪来——它只看 ctx schema 知道有哪些字段可用，然后从中提取特征、形成观点。数据层后续接入新数据源（news、event 等），只要扩展 ctx schema 并有文档，策略代码就能使用。

---

## 2. 架构 — 四层分离

### 2.1 概念分层

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 数据层                                             │
│  多源获取 → 组装成统一 ctx                                    │
│  当前: Polymarket + CLOB + Binance                           │
│  规划: + News API, Event API, ...                            │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: 输入参数                                           │
│  场景不同 → 参数不同（具体定义中）                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: 策略代码（LLM 生成）                                │
│  职责：特征提取 + 观点映射                                    │
│  不取数据、不格式化输出、不做底层计算                           │
│  底层计算由 helper functions 提供（预制件）                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: 输出                                               │
│  Signal[] — 每个市场一条 {decision, side, edge, ...}          │
│  schema 校验由 run_js runner 负责                             │
└─────────────────────────────────────────────────────────────┘
```

**核心原则：策略代码只做两件事——从数据中提取特征，把特征映射成观点。** 其余所有事（数据获取、定价计算、概率转换、edge 计算、格式化输出）都不在策略代码里。定价和计算由 helper functions 承担——它们是预制件，让 LLM 不必从造砖造水泥开始。

### 2.2 执行流程

```
  FETCH                   COMPOSE                   EXECUTE
 ┌──────────────┐       ┌──────────────────┐       ┌────────────────┐
 │  数据层       │       │  LLM 生成        │       │  run_js tool   │
 │  多源获取     │──→    │  特征提取         │──→    │  runner.ts     │
 │  组装 ctx    │  ctx  │  + 观点映射       │ code   │  (子进程沙箱)   │
 └──────────────┘ .json └──────────────────┘       └────────────────┘
                                                          │
                                                     Signal[] + 日志
```

### 2.3 FETCH — 数据层（当前实现）

**入口**: `.claude/skills/polymarket-strategy/fetch.ts`

执行流程：

1. **Gamma API** — 按 slug 获取事件元数据（标题、所有子市场、问题文本、价格）
2. **CLOB API** — 逐市场获取订单簿 → bestBid / bestAsk
3. **Binance API** — 获取 1h K 线（默认 200 根），并行计算 5 个窗口的已实现波动率：
    - 15m（1m K 线 × 15）、1h（5m × 12）、24h（15m × 96）、7d（1h × 168）、30d（4h × 180）
4. **Parser** — 对每个市场的 question 文本做规则匹配 → `questionType` + `strike` + `strike2`
5. **输出** — 写入 `/tmp/polymarket-ctx-<slug>-<pid>-<rand>.json`（50–200 KB）

支持的 `questionType`（7 种）：

| 类型          | 示例                                 | strike | strike2 |
| ------------- | ------------------------------------ | ------ | ------- |
| `above`       | "Will BTC be above $80k?"            | 80000  | null    |
| `below`       | "Will BTC be below $75k?"            | 75000  | null    |
| `range`       | "Will BTC be between $78k and $80k?" | 78000  | 80000   |
| `hit`         | "Will BTC reach $100k?"              | 100000 | null    |
| `firstHit`    | "Will BTC hit $70k or $90k first?"   | 70000  | 90000   |
| `directional` | "Bitcoin Up or Down on April 15?"    | null   | null    |
| `unknown`     | 无法识别                             | null   | null    |

### 2.4 COMPOSE — 策略代码（LLM 生成）

策略代码的职责边界：**特征提取 + 观点映射**，其余不碰。

- **特征提取** — 从 ctx 已有数据中计算有交易含义的指标（RSI、EMA 交叉、vol ratio、距离行权价百分比等）。可调用 helper 原语，也可自己写内联计算。
- **观点映射** — 把特征组合成交易判断（"RSI < 30 + 价格靠近下轨 → YES 被低估 5%"）。映射逻辑由 LLM 根据具体市场现场推理，不是写死的模板。

典型结构：

1. 事件级特征（一次计算，所有市场共享）
2. 根据 questionType 选择基线定价（调用 helper：bsAbove / bsRange / ...）
3. 施加观点调整（幅度、方向由 LLM 决定）
4. 逐市场 try/catch 包裹，返回 Signal[]

### 2.5 EXECUTE — 沙箱执行

**入口**: `src/tools/RunJsTool/RunJsTool.ts` → 派生 `runner.ts` 子进程

执行流程：

1. 从 ctxPath 加载 ctx JSON
2. 动态 import helpers 模块 → 挂载到 `ctx.helpers`
3. `new Function('ctx', userCode)` 编译策略代码
4. `Promise.race([执行, timeout])` 安全运行
5. 校验返回值 shape（`strategy-array` 模式）
6. 写入执行日志（schemaVersion 2），含 ctxHash + gitCommit

安全机制：

- **无模块系统**: 用户代码无法 import/require
- **超时保护**: 默认 5s，最大 30s，超时 hard kill
- **路径约束**: executionLogPath 必须在 CWD 下
- **出处追踪**: ctx 和 helpers 的 SHA256 hash 记录在日志中

---

## 3. 目标架构 — runStrategy 抽象

### 3.1 动机

当前三阶段是手动串联的（人在 Stage 2 衔接）。目标是引入 `runStrategy()` 函数，使整个 pipeline 可编程调用：

```typescript
const signals = await runStrategy({
	adapter: polymarketAdapter, // 数据源抽象
	strategy: myStrategyCode, // 策略代码字符串
	params: { rsiPeriod: 14, threshold: 0.03 },
	slug: "bitcoin-price-april-15",
});
```

### 3.2 DataAdapter 接口

接口只暴露 `buildCtx()`，子方法（fetchGammaEvent / fetchOrderBook / fetchBinanceKlines）是 LiveAdapter 的实现细节，不属于接口契约。

```typescript
interface BuildCtxOpts {
	underlying?: string; // default 'BTC'
	klineLimit?: number; // default 200
}

interface DataAdapter {
	buildCtx(slug: string, opts?: BuildCtxOpts): Promise<Ctx>;
}
```

命名为 **LiveAdapter**（不叫 PolymarketAdapter）——数据源跨多个供应商（Gamma + CLOB + Binance，未来还有 news/event API），`Live` 对应 `Mock`（固定数据）和 `Backtest`（历史回放）。

当前实现：

- **LiveAdapter** (`adapters/live.ts`) — 从 fetch.ts 提取的实时数据获取逻辑，对接 Gamma + CLOB + Binance

后续 phase 新增：

- **MockAdapter** — 测试用，返回固定 ctx（Phase 3 / runStrategy 阶段）
- **BacktestAdapter** — 从历史 ctx 文件加载（Phase 5 / 回测阶段）

### 3.3 Strategy Params（策略模板阶段）

> **前提**：当前阶段策略由 LLM 动态生成，逻辑和数字是一体的，不存在预定义参数。`params` 是**后期优化机制**，适用于已验证的策略被固化为模板之后。

演进路径：

1. **动态生成期（当前）** — LLM 根据 ctx 现场推理，生成完整策略代码。数字（RSI 14、threshold 0.03）是推理结果，不是外部输入。此阶段无需 params。
2. **模板提取期** — 某个策略模式在多个事件上持续有效，将其逻辑冻结为 `.js` 模板文件，把因市场/时段而异的数字抽为 params。
3. **参数优化期** — 用历史 ctx 批量回放模板，grid search 找最优 params 组合。

模板阶段的接口：

```typescript
interface StrategyParams {
	[key: string]: number | string | boolean;
}

// 在模板代码中使用（不是动态生成的策略）
const rsiPeriod = ctx.params.rsiPeriod ?? 14;
const threshold = ctx.params.threshold ?? 0.03;
```

注入方式：`runStrategy({ ..., params: { rsiPeriod: 21, threshold: 0.05 } })` → 合并到 `ctx.params`。

### 3.4 runStrategy Config

```typescript
interface RunStrategyConfig {
	adapter: DataAdapter;
	strategy: string; // JS 函数体
	params?: StrategyParams;
	helpersModulePath?: string;
	timeoutMs?: number; // 默认 5000
	resultShape?: "free" | "strategy-array";
	executionLogPath?: string;
}
```

---

## 4. 数据流

### 4.1 ctx 完整 Schema

```
ctx
├── event
│   ├── slug: string                    "bitcoin-price-april-15"
│   └── title: string                   "Bitcoin price on April 15?"
│
├── markets[]                           二元市场数组
│   ├── slug: string
│   ├── question: string                完整问题文本
│   ├── questionType: QuestionType      解析后的语义类型
│   ├── kind: 'absolute' | 'directional'
│   ├── strike: number | null           行权价（下界）
│   ├── strike2: number | null          行权价（上界，range/firstHit 专用）
│   ├── parser: 'rules'                 解析器标识（预留 'semantic'）
│   ├── confidence: number              解析置信度 0–1
│   ├── expiryDate: string              ISO 日期
│   ├── expiryTs: number                到期时间戳 ms
│   ├── hoursToExpiry: number           距到期小时数
│   ├── outcomes[2]
│   │   ├── label: string               "Yes"/"No" 或 "$60k"/"$80k"
│   │   ├── price: number               中间价 0–1
│   │   ├── bestBid: number | null      CLOB 最优买价
│   │   └── bestAsk: number | null      CLOB 最优卖价
│   ├── volume: number
│   ├── liquidity: number
│   ├── active: boolean
│   └── closed: boolean
│
├── underlying
│   ├── symbol: string                  "BTC"
│   ├── price: number                   当前现货价 USD
│   ├── klines[]                        最多 200 根 1h K 线
│   │   ├── timestamp: number
│   │   ├── open / high / low / close: number
│   │   └── volume: number
│   ├── realizedVol
│   │   ├── '15m': number               年化已实现波动率
│   │   ├── '1h': number
│   │   ├── '24h': number
│   │   ├── '7d': number
│   │   └── '30d': number
│   └── realizedVolWarnings: string[]   获取失败的窗口
│
├── timing
│   └── nowTs: number                   获取时刻的时间戳 ms
│
├── helpers                             (运行时注入，非序列化)
│   ├── [统计基础]   normCDF, mean, stdev, quantile
│   ├── [技术指标]   sma, emaArray, rsi, logReturns
│   ├── [定价模型]   bsAbove, bsRange, bsOneTouch, firstHitProbabilities
│   ├── [概率转换]   binaryProbsFromYesProb, edgeFromProbs
│   ├── [波动率]     vol, volRatio
│   ├── [距离特征]   distanceToStrike, distanceToRangeMid, distanceToBarriers
│   ├── [动量特征]   empiricalProbUp
│   ├── [订单簿]     outcomeSides, yesSide, noSide,
│   │                outcomeAsks, outcomeBids, spreadByOutcome, noArbResidual
│   ├── [事件级]     eventQuestionTypes, eventPrimaryQuestionType
│   └── [时间]       timeToExpiryHours, timeToExpiryYears
│
└── params                              (目标架构，尚未实现)
    └── [key: string]: number | string | boolean
```

### 4.2 Signal 输出 Schema

每个市场产生一条信号：

```typescript
interface Signal {
	question: string; // 市场问题文本
	decision: "buy" | "hold"; // 当前仅 buy/hold，见下方说明
	side?: string; // 买哪边 ("Yes" / "No" / "$80k")
	edge?: number; // fairPrice - askPrice
	fairPrice?: number; // 模型估算的公允价格
	marketPrice?: number; // 当前市场卖价
	probs?: [number, number]; // 模型概率 [p0, p1]
	reason?: string; // hold 原因（出错时填写）
}
```

**为什么没有 `sell`？** 当前系统不追踪持仓，只输出开仓建议。`buy` + `side` 已覆盖做多/做空方向。但注意「买 No」≠「卖掉已持有的 Yes」——前者是开新仓，后者是平仓，两者锁定不同资金。后续引入仓位管理后，需新增 `sell` 决策，表示「平掉当前持仓」。

策略返回 `Signal[]`，由 `run_js` 的 `strategy-array` shape 校验保证格式正确。

### 4.3 执行日志 Schema (v2)

```typescript
interface ExecutionLog {
	schemaVersion: 2;
	timestamp: string; // ISO UTC
	status: "success" | "error";
	ctxPath: string | null;
	ctxHash: string; // SHA256
	helpersModulePath: string | null;
	helpersHash: string | null; // SHA256
	gitCommit: string | null;
	code: string; // 策略代码全文
	durationMs: number;
	result: Signal[] | ErrorDetail;
	errorKind?: "timeout" | "throw" | "syntax" | "schema" | "io";
	error?: { message: string; name: string };
}
```

---

## 5. 文件结构

```
.claude/skills/polymarket-strategy/
├── SKILL.md                            工作流文档 + API 参考
├── fetch.ts                            数据获取（Gamma + CLOB + Binance）
├── parser.ts                           问题文本规则解析器（import types/）
├── helpers.ts                          30+ 数学/定价/特征工具函数（import types/）
├── tsconfig.json                       本地 TS 配置
├── types/
│   └── index.ts                        共享类型定义（QuestionType, VolWindow, SideInfo 等）
├── adapters/
│   └── live.ts                         LiveAdapter — 实时数据获取（Gamma + CLOB + Binance）
└── __tests__/
    ├── parser.test.ts                  解析器测试
    └── helpers.test.ts                 工具函数测试（420 行）

src/tools/RunJsTool/
├── RunJsTool.ts                        工具定义 + 输入/输出 schema（148 行）
├── runner.ts                           子进程执行器 + 超时 + 出处追踪（262 行）
├── constants.ts                        工具名称等常量
├── display.ts                          终端 UI 渲染
└── RunJsTool.test.ts                   测试（300 行）

.claude/polymarket-strategy-runs/       执行日志目录
└── <slug>/
    └── <timestamp>-<pid>-<rand>.json   单次执行日志

/tmp/polymarket-ctx-<slug>-*.json       临时 ctx 文件（fetch 产出）
```

---

## 6. 关键接口定义

### 6.1 定价原语（helpers.ts）

| 函数                                 | 输入         | 输出               | 用途                         |
| ------------------------------------ | ------------ | ------------------ | ---------------------------- |
| `bsAbove(mCtx, opts?)`               | 单市场上下文 | P(S_T > K)         | above/below 基线             |
| `bsRange(mCtx, opts?)`               | 同上         | P(K₁ ≤ S_T ≤ K₂)   | range 基线                   |
| `bsOneTouch(mCtx, opts?)`            | 同上         | P(touch barrier)   | hit 基线                     |
| `firstHitProbabilities(mCtx, opts?)` | 同上         | [p_lower, p_upper] | firstHit 基线（Monte Carlo） |
| `binaryProbsFromYesProb(mCtx, pYes)` | 标量概率     | [p0, p1]           | 对齐 outcome 顺序            |
| `edgeFromProbs(probs, mCtx)`         | [p0, p1]     | Edge[]             | 计算每边 edge                |

`opts` 公共参数：

- `sigmaWindow?: string` — 选择哪个 realizedVol 窗口（默认 '24h'）
- `sigmaOverride?: number` — 直接指定 σ
- `simPaths?: number` — Monte Carlo 路径数（仅 firstHit）
- `seed?: number` — 固定随机种子

### 6.2 特征函数（helpers.ts）

| 函数                           | 返回值                               | 说明                 |
| ------------------------------ | ------------------------------------ | -------------------- |
| `rsi(closes, period?)`         | number (0–100)                       | Wilder-smoothed RSI  |
| `vol(window)`                  | number                               | 年化已实现波动率     |
| `volRatio(short, long)`        | number                               | 短期 / 长期 vol 比值 |
| `distanceToStrike()`           | number                               | (K - S) / S          |
| `distanceToBarriers()`         | {pctToLower, pctToUpper, logDist...} | 双障碍距离           |
| `empiricalProbUp({lookback?})` | number (0–1)                         | 近期上涨 K 线占比    |
| `noArbResidual()`              | number[]                             | 每边的无套利残差     |

### 6.3 run_js 工具接口

**输入**:

```typescript
{
  code: string;                         // 策略函数体
  ctx?: unknown;                        // 内联 ctx（ctxPath 优先）
  ctxPath?: string;                     // ctx JSON 文件路径
  helpersModulePath?: string;           // helpers 模块路径
  executionLogPath?: string;            // 日志写入路径（必须在 CWD 下）
  resultShape?: 'free' | 'strategy-array';
  timeoutMs?: number;                   // 默认 5000，最大 30000
}
```

**输出**:

```typescript
{
  result: unknown;                      // 策略返回值
  durationMs: number;
  executionLogPath?: string;
}
```

---

## 7. 回测预留设计

### 7.1 核心思路：ctx 持久化 + 历史回放

回测的 bedrock truth：**同一 ctx + 同一代码 = 同一信号**。因此回测只需要：

1. **收集历史 ctx** — 定时抓取并保存完整 ctx JSON
2. **记录 resolution** — 市场结算后记录实际结果
3. **回放** — 用历史 ctx 跑策略，对比信号 vs 实际结果

### 7.2 数据模型

```typescript
interface HistoricalCtx {
	capturedAt: string; // ISO UTC，抓取时间
	ctx: Ctx; // 完整 ctx 快照
	resolution?: {
		resolvedAt: string; // 结算时间
		outcomes: Array<{
			question: string;
			winningOutcome: string; // "Yes" / "No" / "$80k" 等
			settlementPrice: number; // 最终现货价（如有）
		}>;
	};
}
```

### 7.3 BacktestAdapter 草案

```typescript
class BacktestAdapter implements DataAdapter {
	constructor(private ctxStore: HistoricalCtx[]) {}

	async buildCtx(slug: string): Promise<Ctx> {
		// 从 ctxStore 中按 slug + 时间查找
		const entry = this.ctxStore.find((h) => h.ctx.event.slug === slug);
		if (!entry) throw new Error(`No historical ctx for slug: ${slug}`);
		return entry.ctx;
	}
	// DataAdapter 接口只有 buildCtx，无需实现子方法
}
```

### 7.4 回测执行流程

```
历史 ctx 文件 ──→ BacktestAdapter.buildCtx()
                         │
                         ↓
                  runStrategy({
                    adapter: backtestAdapter,
                    strategy: code,
                    params: { ... },
                  })
                         │
                         ↓
                    Signal[] ──→ 与 resolution 对比
                                     │
                                     ↓
                              胜率、平均 edge、PnL 曲线
```

### 7.5 实施前提

| 依赖项           | 状态       | 说明                                                |
| ---------------- | ---------- | --------------------------------------------------- |
| ctx 持久化存储   | **未实现** | 需定时任务 + 存储策略（文件 / SQLite）              |
| Resolution 抓取  | **未实现** | 需轮询已到期市场的结算结果                          |
| DataAdapter 抽象 | **已完成** | LiveAdapter 从 fetch.ts 提取，接口在 types/index.ts |
| params 注入      | **未实现** | ctx.params 尚未接入                                 |
| runStrategy 编排 | **未实现** | 三阶段仍靠手动串联                                  |

---

## 8. 实施路线（渐进式）

### Phase 0 — Repo 结构重组 ✅

在 `.claude/skills/polymarket-strategy/` 内部新增子目录，不搬家（SKILL.md 依赖 `${CLAUDE_SKILL_DIR}` 路径替换）：

- `types/index.ts` — 提取共享类型（QuestionType、VolWindow、SideInfo 等），消除 parser.ts 和 helpers.ts 之间的重复定义
- `adapters/.gitkeep` — Phase 1 落点
- `__tests__/` — 测试文件从根目录移入，import 路径更新为 `../parser`、`../helpers`

RunJsTool 保留在 `src/tools/RunJsTool/` 原位（它是通用执行引擎，不专属 strategy）。

交付标准：37 个测试全部通过，helpers.ts 中无本地 QuestionType 定义。

### Phase 1 — DataAdapter 抽象 ✅

> 前置：Phase 0。动机：很快会接入 news、event 等新数据源。

1. 定义 `DataAdapter` 接口 + `Ctx` 类型（在 `types/index.ts`）
2. 从 fetch.ts 提取 `LiveAdapter`（`adapters/live.ts`），实现该接口
3. fetch.ts 瘦身为 CLI 薄壳（~55 行），调用 `LiveAdapter.buildCtx()`
4. 测试：mock `fetch()` 验证 buildCtx 返回值 shape + error path

MockAdapter / BacktestAdapter 留到 Phase 3（runStrategy）和 Phase 5（回测）——当前没有消费者。

### Phase 2 — Helper 扩充

> 前置：Phase 0。配合当前 LLM prompt 调优。

目标：让策略代码更短、更专注于特征提取和观点映射。识别 LLM 反复手写的计算逻辑，下沉到 helpers：

- 调优过程中发现的高频模式 → 新增 helper
- 格式化输出的样板代码 → 新增 helper
- helpers.ts 保持单文件，内部用注释分区

### Phase 3 — runStrategy 编排

> 前置：Phase 1。

1. 实现 `runStrategy()` 函数，串联 adapter.buildCtx() → runner
2. 手动三阶段仍然可用（向后兼容）
3. 后续模板化阶段可接入 params 注入

### Phase 4 — ctx 持久化 + Resolution

> 前置：Phase 1（需要 adapter 抽象）。

1. 每次 fetch 自动保存 ctx 快照（按 slug + 时间戳索引）
2. 市场到期后抓取结算结果（resolution）
3. 存储：初期文件系统，后期可迁 SQLite

### Phase 5 — 回测引擎

> 前置：Phase 3 + Phase 4。

1. 实现 `BacktestAdapter`（从历史 ctx 加载）
2. 批量回放 + PnL 计算
3. 策略模板化后：params grid search
4. 报告：胜率、edge 分布、最大回撤

### 已完成

- [x] fetch.ts 数据获取（Gamma + CLOB + Binance）
- [x] parser.ts 规则解析（7 种 questionType）
- [x] helpers.ts 定价原语（BS + Monte Carlo + 30 个工具函数）
- [x] run_js 沙箱执行引擎（超时 + 出处追踪）
- [x] 多市场 / bucket-family 支持（ctx.markets[]）
- [x] 测试覆盖（helpers 420 行 + parser 57 行 + RunJsTool 300 行）

---

## 附录 A — 设计决策记录

| 决策                           | 理由                                                   |
| ------------------------------ | ------------------------------------------------------ |
| ctx 通过文件传递，不内联       | ctx 50–200 KB，JSON 内联有序列化开销                   |
| helpers 作为独立模块           | 可独立测试、版本控制、复用                             |
| log-odds 空间做调整            | 自动保证二元概率归一（simplex 约束）                   |
| 用户代码无 import/require      | `new Function()` 沙箱，阻断文件系统访问                |
| 零漂移 BS 作为基线             | 风险中性假设简化了解释；alpha 来源于调整项             |
| 规则解析器而非 ML              | 快速、确定性、可 debug；预留 `parser: 'semantic'` 扩展 |
| 每市场 try/catch               | 一个市场出错不影响其他市场的信号生成                   |
| 执行日志含 ctxHash + gitCommit | 可复现性：精确追溯输入数据和代码版本                   |

## 附录 B — 术语表

| 术语              | 含义                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| **Event**         | Polymarket 上的一个事件（如 "Bitcoin price on April 15?"），包含多个子市场 |
| **Market**        | 一个二元结果市场（如 "Will BTC be above $80k?"），有 Yes/No 两个 outcome   |
| **Bucket-family** | 同一事件下的多个 range 市场，覆盖完整价格区间                              |
| **ctx**           | 策略运行时的完整上下文对象，包含市场、行情、时间、工具函数                 |
| **mCtx**          | 单市场上下文，`{ market, underlying, timing }`                             |
| **questionType**  | 市场问题的语义分类（above / below / range / hit / firstHit / directional） |
| **edge**          | fairPrice - askPrice，正值表示被低估                                       |
| **signal**        | 策略对一个市场的输出（decision + 元数据）                                  |
| **BS**            | Black-Scholes 模型（零漂移对数正态）                                       |
| **log-odds**      | `logit(p) = ln(p / (1-p))`，在此空间做加法调整可保持概率归一               |
| **simplex**       | 概率空间约束：所有 outcome 概率之和 = 1                                    |
| **resolution**    | 市场结算——到期后确定哪个 outcome 获胜                                      |
