/**
 * 催化推演 · 情绪面工具集（function calls）
 *
 * 设计文档：催化推演-联网情绪分析-设计.md
 * 模型通过 chatWithTools 按需调用；预取情绪包 prefetchSentiment 在轮A前并行准备，兜底 + 减少工具轮次。
 * 全部只读；单工具超时 6s、结果 ≤4000 字符（chatWithTools 回填时再裁一次）；各工具独立 TTL 缓存。
 *
 * 文案纪律：卡片/工具输出是运行时文本，禁用第一档字样（股/交易/盯盘/盘前 等），一律用「标的/市场」表述。
 */

import { readHotStocks } from '../store.js'
import { fetchConceptBoards, fetchRankList, fetchPool } from '../fetch/eastmoney.js'
import { fetchLimitUpReasons } from '../fetch/ths.js'
import { HOT_SOURCES } from '../fetch/hot.js'

const CODE = /^\d{6}$/
const SOURCE_LABEL = Object.fromEntries(HOT_SOURCES.map((s) => [s.key, s.label]))

/** 北京时间交易日 YYYYMMDD（executeTool 未传 date 时的默认值） */
function tradeDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

// ---------- 通用：TTL 缓存 / 超时 / 字符裁剪 ----------

const memo = new Map()
function cacheGet(key, ttlMs) {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  return null
}
function cacheSet(key, value) {
  memo.set(key, { at: Date.now(), value })
  if (memo.size > 200) { // 粗清理，避免 isolate 内存无界
    for (const k of memo.keys()) { memo.delete(k); break }
  }
}
function timeout(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}
function clampChars(value, max = 4000) {
  const text = JSON.stringify(value)
  if (!text || text.length <= max) return value
  return { truncated: true, note: '结果过长已截断', data: text.slice(0, max) }
}
function errText(err) {
  return { error: String((err && err.message) || err).slice(0, 120) }
}

// ---------- 工具 schema（OpenAI 兼容，随 messages.tools 传给模型） ----------

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜索消息/标的/题材的公开报道与讨论，用于核实事件与感受网络情绪。返回标题+摘要+来源+日期。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，一次一个主题，不超过30字' },
          freshness: { type: 'string', enum: ['24h', '48h', '7d', '30d'], description: '时间窗，默认48h' },
          limit: { type: 'integer', minimum: 3, maximum: 8, description: '条数，默认5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hot_stocks',
      description: '全市场多源人气榜聚合（东财/同花顺/雪球/淘股吧，每小时更新），判断当前市场情绪焦点与人气标的。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 5, maximum: 20, description: '取前N个，默认10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_heat',
      description: '查询指定标的的多源人气排名、当日涨跌幅与连板情况，判断它是否已是情绪载体。',
      parameters: {
        type: 'object',
        properties: {
          codes: {
            type: 'array',
            items: { type: 'string', pattern: '^\\d{6}$' },
            minItems: 1,
            maxItems: 8,
            description: '6位标的代码，最多8个',
          },
        },
        required: ['codes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hot_topics',
      description: '当前市场热门题材聚合：涨停原因分布 + 概念板块涨幅榜，用于情绪载体与网络话题的共振判断。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 5, maximum: 15, description: '题材条数，默认10' },
        },
      },
    },
  },
]

// ---------- 工具实现 ----------

/** 多源人气榜聚合：readHotStocks（hot_stock 表）→ code → 各源名次 */
async function aggregateHot(env) {
  const cached = cacheGet('hot_agg', 5 * 60 * 1000)
  if (cached) return cached
  const rows = await readHotStocks(env)
  const byCode = new Map()
  let fetchedAt = null
  for (const r of rows) {
    if (!CODE.test(r.code)) continue
    if (r.fetchedAt && (!fetchedAt || r.fetchedAt > fetchedAt)) fetchedAt = r.fetchedAt
    let agg = byCode.get(r.code)
    if (!agg) { agg = { code: r.code, name: r.name || '', sources: [], hits: 0, bestRank: Infinity }; byCode.set(r.code, agg) }
    if (!agg.name && r.name) agg.name = r.name
    agg.sources.push((SOURCE_LABEL[r.source] || r.source) + '#' + r.rank)
    agg.hits++
    if (r.rank < agg.bestRank) agg.bestRank = r.rank
  }
  const list = [...byCode.values()].sort((a, b) => (b.hits - a.hits) || (a.bestRank - b.bestRank))
  const out = { fetchedAt, list }
  cacheSet('hot_agg', out)
  return out
}

async function hotStocks(args, env) {
  const limit = Math.min(20, Math.max(5, Number(args.limit) || 10))
  const { fetchedAt, list } = await aggregateHot(env)
  return {
    ref: 'H',
    label: '站内·多源人气榜' + (fetchedAt ? '（更新 ' + fetchedAt + '）' : ''),
    fetchedAt,
    note: '多源人气榜（每小时更新），sources 为各源名次；引用本结果时句尾带角标 [H]',
    items: list.slice(0, limit).map((it) => ({ code: it.code, name: it.name, hits: it.hits, sources: it.sources })),
  }
}

/** 当日涨幅榜（f3）内存缓存 60s，供 get_stock_heat 补当日涨跌幅 */
async function rankMap() {
  const cached = cacheGet('rank_f3', 60 * 1000)
  if (cached) return cached
  const rows = await fetchRankList('f3', 250)
  const map = new Map(rows.map((r) => [r.code, r]))
  cacheSet('rank_f3', map)
  return map
}

/** 当日涨停池缓存 60s，供连板/炸板状态 */
async function ztPool(date) {
  const key = 'zt_pool_' + date
  const cached = cacheGet(key, 60 * 1000)
  if (cached) return cached
  const rows = await fetchPool('zt', date)
  const map = new Map(rows.map((r) => [r.code, r]))
  cacheSet(key, map)
  return map
}

async function stockHeat(args, env, date) {
  const codes = (Array.isArray(args.codes) ? args.codes : []).filter((c) => CODE.test(c)).slice(0, 8)
  if (!codes.length) return { error: 'codes 需为 6 位代码数组' }
  const { list } = await aggregateHot(env)
  const hotByCode = new Map(list.map((it) => [it.code, it]))
  const [ranks, pools] = await Promise.all([
    rankMap().catch(() => new Map()),
    date ? ztPool(date).catch(() => new Map()) : Promise.resolve(new Map()),
  ])
  return {
    ref: 'P',
    label: '站内·标的热度画像（人气排名/涨跌幅/连板）',
    items: codes.map((code) => {
      const hot = hotByCode.get(code)
      const rank = ranks.get(code)
      const zt = pools.get(code)
      return {
        code,
        name: (hot && hot.name) || (rank && rank.name) || '',
        hotSources: hot ? hot.sources : null,          // 多源人气名次，非空即已在人气榜
        changePct: rank ? rank.changePct : null,        // 当日涨跌幅（百分数），不在涨幅榜前250则空
        lianban: zt ? zt.lianban || 0 : null,           // 连板数，非涨停标为空
        broken: zt ? zt.broken || 0 : null,             // 当日炸板次数
      }
    }),
  }
}

/** 热门题材：涨停原因计数 + 概念板块涨幅榜 */
async function hotTopics(args, env, date) {
  const limit = Math.min(15, Math.max(5, Number(args.limit) || 10))
  const cacheKey = 'hot_topics_' + date + '_' + limit
  const cached = cacheGet(cacheKey, 5 * 60 * 1000)
  if (cached) return cached
  const [reasons, boards] = await Promise.all([
    date ? fetchLimitUpReasons(date).catch(() => new Map()) : Promise.resolve(new Map()),
    fetchConceptBoards().catch(() => []),
  ])
  const counts = new Map()
  for (const reason of reasons.values()) {
    if (!reason) continue
    for (const part of String(reason).split('+').map((t) => t.trim()).filter(Boolean)) {
      counts.set(part, (counts.get(part) || 0) + 1)
    }
  }
  const topics = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic, n]) => ({ topic, ztCount: n }))
  const topBoards = boards
    .filter((b) => Number.isFinite(b.changePct))
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, limit)
    .map((b) => ({ board: b.name, changePct: Number(b.changePct.toFixed(2)) }))
  const out = {
    ref: 'T',
    label: '站内·题材与板块热度（' + date + '）',
    date,
    topics,
    topBoards,
  }
  cacheSet(cacheKey, out)
  return out
}

/** 联网搜索（P1）：按 SEARCH_PROVIDER 适配；默认 none 时明确告知模型走站内工具 */
async function searchWeb(args, env) {
  const provider = String(env.SEARCH_PROVIDER || 'none').toLowerCase()
  const query = String(args.query || '').slice(0, 60)
  if (!query) return { error: '缺少 query' }
  if (provider === 'none' || !env.SEARCH_API_KEY) {
    return { error: '联网搜索未配置（SEARCH_PROVIDER=none），请改用 get_hot_stocks / get_stock_heat / get_hot_topics 站内数据' }
  }
  // P1：tavily / bocha / bing 适配器；统一输出 {title, snippet, source, date, url}
  return { error: '搜索适配器 ' + provider + ' 尚未实现' }
}

/** 未配置搜索（SEARCH_PROVIDER=none 且无 key）时不向模型暴露 search_web，避免浪费工具轮次 */
export function activeTools(env) {
  const provider = String(env.SEARCH_PROVIDER || 'none').toLowerCase()
  const searchReady = provider !== 'none' && !!env.SEARCH_API_KEY
  return searchReady ? TOOLS : TOOLS.filter((t) => t.function.name !== 'search_web')
}

// ---------- 执行器 ----------

const REGISTRY = {
  search_web: (args, env, date) => searchWeb(args, env),
  get_hot_stocks: (args, env) => hotStocks(args, env),
  get_stock_heat: (args, env, date) => stockHeat(args, env, date),
  get_hot_topics: (args, env, date) => hotTopics(args, env, date),
}

export async function executeTool(name, argsJson, env, date) {
  const fn = REGISTRY[name]
  if (!fn) return { error: '未知工具 ' + name }
  let args = {}
  try { args = JSON.parse(argsJson || '{}') } catch { return { error: '参数不是合法 JSON' } }
  const effDate = date || tradeDate()
  const t0 = Date.now()
  try {
    const out = await Promise.race([fn(args, env, effDate), timeout(6000, { error: '工具超时' })])
    console.log('[tools]', name, (Date.now() - t0) + 'ms', out && out.error ? 'ERR:' + out.error : 'ok')
    return clampChars(out, 4000)
  } catch (err) {
    console.log('[tools]', name, (Date.now() - t0) + 'ms', 'THROW', errText(err).error)
    return errText(err)
  }
}

// ---------- 预取情绪包（轮A前并行准备，不经模型） ----------

/**
 * @returns {Promise<object|null>} {hotText, topicsText} 供 buildMessages 注入 user 消息；
 *                                  失败返回 null，调用方按无情绪包继续
 */
export async function prefetchSentiment(env, { date } = {}) {
  const effDate = date || tradeDate()
  const [hot, topics] = await Promise.all([
    hotStocks({ limit: 10 }, env).catch(() => null),
    hotTopics({ limit: 10 }, env, effDate).catch(() => null),
  ])
  if (!hot && !topics) return null
  const hotText = hot && hot.items && hot.items.length
    ? hot.items.map((it) => `${it.name || it.code}(${it.code} ${it.sources.join('/')})`).join('；') +
      (hot.fetchedAt ? `（更新 ${hot.fetchedAt}）` : '')
    : null
  const topicsText = topics
    ? [
        topics.topics && topics.topics.length
          ? '涨停原因热度：' + topics.topics.map((t) => `${t.topic}×${t.ztCount}`).join('、') : '',
        topics.topBoards && topics.topBoards.length
          ? '板块涨幅前列：' + topics.topBoards.map((b) => `${b.board} ${b.changePct > 0 ? '+' : ''}${b.changePct}%`).join('、') : '',
      ].filter(Boolean).join(' ｜ ') || null
    : null
  if (!hotText && !topicsText) return null
  return {
    hotText,
    topicsText,
    legend: [
      ...(hotText ? [{ ref: 'H', label: '站内·多源人气榜' + (hot.fetchedAt ? '（更新 ' + hot.fetchedAt + '）' : '') }] : []),
      ...(topicsText ? [{ ref: 'T', label: '站内·题材与板块热度（' + effDate + '）' }] : []),
    ],
  }
}
