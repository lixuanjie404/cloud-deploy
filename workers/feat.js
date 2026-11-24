/**
 * 辨识度因子只读接口（Cloudflare Workers）
 *
 *   GET /api/feat/factor?codes=600127,002242&bench=000300
 *   GET /api/feat/candidates?limit=30&date=YYYYMMDD   自动扫描全市场涨停/炸板/热门池
 *   GET /api/feat/spec
 *
 * 数据策略：候选池自动扫描全市场（不局限库内标的）；涨停/炸板池按 date 现拉，
 * 热门人气股读 hot_stock 表（每小时 Cron 聚合东财/同花顺/雪球/淘股吧四源，表空回退东财现拉），
 * 涨幅/成交额榜补充非涨停强势股（辨识度不以涨停为前提）。
 * K 线优先读 daily_bar 缓存，表内无数据时回退 push2his 现拉。名称优先读 stock_list 映射，缺失才查东财。
 *
 * 安全边界（沿用 db.js）：只允许 GET；代码走 6 位数字校验；codes 数量上限；
 * 带 Cache-Control 与数据截止日，明示新鲜度。
 */

import { fetchDaily, fetchPool, fetchHotRank, fetchRankList, fetchName, INDEXES, indexDbCode, stockSecid } from './fetch/eastmoney.js'
import { fetchLimitUpReasons } from './fetch/ths.js'
import { fetchDxxThemes } from './fetch/dxx.js'
import { HOT_SOURCES } from './fetch/hot.js'
import { readDailyBarsBatch, readBarsWithNames, readHotStocks } from './store.js'
import { computeKlineFactors, FACTOR_SPEC } from './factors.js'

const CODE = /^\d{6}$/
const MAX_CODES = 20

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/** GET /api/feat/spec —— 返回单一因子口径表（JS 与 Prompt 共用） */
export function handleSpec() {
  return json({ ok: true, spec: FACTOR_SPEC }, 200, 'public, max-age=300')
}

/**
 * GET /api/feat/factor —— 现拉全历史并计算 K 线类因子
 * @param {string} codes 逗号分隔的 6 位标的代码
 * @param {string} bench 基准指数代码（默认 000300 沪深300）
 */
export async function handleFactor(url, env) {
  const codesRaw = url.searchParams.get('codes') || ''
  const bench = url.searchParams.get('bench') || '000300'

  const codes = codesRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!codes.length) return json({ ok: false, error: '缺少 codes 参数' }, 400)
  if (codes.length > MAX_CODES) return json({ ok: false, error: `codes 最多 ${MAX_CODES} 个` }, 400)
  const bad = codes.filter((c) => !CODE.test(c))
  if (bad.length) return json({ ok: false, error: `非法代码: ${bad.join(', ')}` }, 400)
  if (!CODE.test(bench)) return json({ ok: false, error: '基准指数代码需为 6 位数字' }, 400)

  const benchSecid = INDEXES[bench] || stockSecid(bench)

  // 一次连接批量读表：基准候选 + 所有标的
  const min = FACTOR_SPEC.window.breakout + FACTOR_SPEC.window.ret + 1
  const benchCandidates = [bench, indexDbCode(bench)]
  const specs = []
  for (const c of benchCandidates) specs.push({ code: c, adjust: 'idx' })
  for (const code of codes) specs.push({ code, adjust: 'raw' })

  let tableData = new Map()
  try {
    tableData = await readDailyBarsBatch(env, specs)
  } catch {
    // 表不可读时全部回退现拉
  }

  function pickTable(candidateCodes, adjust) {
    for (const c of candidateCodes) {
      const bars = tableData.get(c + '|' + adjust)
      if (bars && bars.length >= min) return { bars, source: 'table' }
    }
    return null
  }

  const benchHit = pickTable(benchCandidates, 'idx')
  const benchData = benchHit || await fetchDaily(benchSecid)
  if (!benchData) return json({ ok: false, error: `基准 ${bench} 历史取数失败` }, 502)
  if (benchData && !benchData.source) benchData.source = 'live'

  const results = []
  for (const code of codes) {
    const hit = pickTable([code], 'raw')
    const data = hit || await fetchDaily(stockSecid(code))
    if (!data) {
      results.push({ code, ok: false, error: '历史取数失败' })
      continue
    }
    if (!data.source) data.source = 'live'
    const factors = computeKlineFactors(data.bars, benchData.bars)
    const indep = factors.independence
    const label = indep != null && indep > FACTOR_SPEC.thresholds.independence
      ? '独立走势'
      : '普通'
    results.push({
      code,
      ok: true,
      name: data.name || code,
      source: data.source,
      label,
      ...factors,
    })
  }

  const anyOk = results.some((r) => r.ok)
  const asOf = results.find((r) => r.asOf)?.asOf || benchData.bars[benchData.bars.length - 1].date

  return json(
    {
      ok: anyOk,
      specVersion: FACTOR_SPEC.version,
      bench,
      benchName: benchData.name || bench,
      asOf,
      cacheDaysHint: '情绪池类因子仅约14个日线，K线类因子全历史',
      rows: results,
    },
    200,
    'public, max-age=60, s-maxage=120',
  )
}

/**
 * 最近有数据的日期 YYYYMMDD（按北京时间），用于情绪池按 date 回拉
 */
function recentTradeDate() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * GET /api/feat/candidates —— 自动扫描全市场候选池
 * 数据源：东财涨停池 + 炸板池（现拉）+ 热门人气股（hot_stock 表，每小时四源聚合：
 * 东财/同花顺/雪球/淘股吧；表空回退东财人气榜现拉）+ 涨幅/成交额榜（补非涨停强势股，剔除 ST）。
 * 辨识度不以涨停为前提：保留约 1/4 名额给未上情绪池/热榜的强势股，
 * 最终按独立性因子降序展示；标注看独立性/连板/炸板，涨停本身不再单独定性。
 * 因子：优先读 daily_bar 缓存，缺失回退现拉；名称优先 stock_list 映射。
 * themes 优先 duanxianxia 异动解析（env.DXX_TOKEN，带缓存与现拉预算），
 * 回退同花顺涨停池 reason_type；两者皆无为 null，前端回退 industry。
 * 响应级 SWR 缓存：60s内直接命中；10min内先回旧数据并后台刷新（ctx.waitUntil）
 */
const CAND_FRESH_MS = 60 * 1000
const CAND_STALE_MS = 10 * 60 * 1000
const candCache = new Map()

export async function handleCandidates(url, env, ctx) {
  const limit = Math.min(40, Math.max(5, Number(url.searchParams.get('limit')) || 24))
  const date = url.searchParams.get('date') || recentTradeDate()
  const key = date + '|' + limit
  const now = Date.now()
  const hit = candCache.get(key)

  if (hit && now - hit.at < CAND_FRESH_MS) return cachedJson(hit.body, 'hit')
  if (hit && now - hit.at < CAND_STALE_MS) {
    if (!hit.busy) {
      hit.busy = true
      const p = computeCandidates(limit, date, env)
        .then(({ body }) => { if (body.ok) candCache.set(key, { at: Date.now(), body }) })
        .catch(() => {})
        .finally(() => { hit.busy = false })
      if (ctx && ctx.waitUntil) ctx.waitUntil(p)
    }
    return cachedJson(hit.body, 'stale')
  }
  const { status, body } = await computeCandidates(limit, date, env)
  if (body.ok) candCache.set(key, { at: Date.now(), body })
  return json(body, status, 'public, max-age=60, s-maxage=120')
}

function cachedJson(body, tag) {
  const res = json(body, 200, 'public, max-age=60, s-maxage=120')
  res.headers.set('X-Cache', tag)
  return res
}

async function computeCandidates(limit, date, env) {

  // 1. 涨停/炸板池、涨幅/成交额榜、热榜落表并行拉取；同花顺涨停解析补炒作题材
  const [zt, zb, rankUp, rankAmt, thsReasons, hotRows0] = await Promise.all([
    fetchPool('zt', date),
    fetchPool('zb', date),
    fetchRankList('f3', 100),
    fetchRankList('f6', 50),
    fetchLimitUpReasons(date).catch(() => new Map()),
    readHotStocks(env).catch(() => []),
  ])

  let hotRows = hotRows0
  const hotFallback = !hotRows.length
  if (hotFallback) {
    const live = await fetchHotRank(50)
    hotRows = live.map((it) => ({ source: 'em', code: it.code, name: '', rank: it.rank, fetchedAt: null }))
  }

  if (!zt.length && !zb.length && !hotRows.length && !rankUp.length && !rankAmt.length) {
    return { status: 502, body: { ok: false, error: '情绪池、热度榜与排行均无数据（可能休市或上游不可达）' } }
  }

  // 热榜聚合：code → { name, sources: [{key,label,rank}], bestRank }
  const labelOf = Object.fromEntries(HOT_SOURCES.map((s) => [s.key, s.label]))
  const hotAgg = new Map()
  const hotBySource = {}
  let hotAsOf = null
  for (const r of hotRows) {
    if (!CODE.test(r.code)) continue
    hotBySource[r.source] = (hotBySource[r.source] || 0) + 1
    if (r.fetchedAt && (!hotAsOf || r.fetchedAt > hotAsOf)) hotAsOf = r.fetchedAt
    let agg = hotAgg.get(r.code)
    if (!agg) {
      agg = { name: '', sources: [], bestRank: Infinity }
      hotAgg.set(r.code, agg)
    }
    if (!agg.name && r.name) agg.name = r.name
    agg.sources.push({ key: r.source, label: labelOf[r.source] || r.source, rank: r.rank })
    if (r.rank < agg.bestRank) agg.bestRank = r.rank
  }

  // 2. 合并去重，打来源标签
  const byCode = new Map()
  function add(item, src, extra) {
    if (!item.code || !CODE.test(item.code)) return
    const prev = byCode.get(item.code)
    const tags = prev ? prev.tags.slice() : []
    if (!tags.includes(src)) tags.push(src)
    byCode.set(item.code, Object.assign({}, prev, item, { tags }, extra || {}))
  }
  for (const it of zt) add(it, '涨停', { lianban: it.lianban, firstSeal: it.firstSeal, industry: it.industry, broken: it.broken })
  for (const it of zb) add(it, '炸板', { lianban: it.lianban, firstSeal: it.firstSeal, industry: it.industry, broken: it.broken })
  for (const [code, agg] of hotAgg) {
    add(agg.name ? { code, name: agg.name } : { code }, '热门', { hotRank: agg.bestRank, hotSources: agg.sources })
  }

  // 涨幅/成交额榜：已入池标的补涨幅/成交额；未入池的进强势股通道
  const rankInfo = new Map()
  for (const it of [...rankUp, ...rankAmt]) {
    const prev = rankInfo.get(it.code)
    if (!prev || (it.changePct || 0) > (prev.changePct || 0)) rankInfo.set(it.code, it)
  }
  for (const [code, it] of rankInfo) {
    const c = byCode.get(code)
    if (c) {
      c.changePct = it.changePct
      c.amount = it.amount
    }
  }
  const strongPool = Array.from(rankInfo.values())
    .filter((it) => !byCode.has(it.code) && it.changePct != null && !/ST/i.test(it.name))
    .sort((a, b) => b.changePct - a.changePct)

  // 3. 选股：热度主通道 + 强势股保留名额（约 1/4，辨识度不以涨停为前提）
  function heatSort(a, b) {
    const ha = hotAgg.get(a.code)
    const hb = hotAgg.get(b.code)
    const na = ha ? ha.sources.length : 0
    const nb = hb ? hb.sources.length : 0
    if (na !== nb) return nb - na
    const ra = ha ? ha.bestRank : Infinity
    const rb = hb ? hb.bestRank : Infinity
    if (ra !== rb) return ra - rb
    if ((b.lianban || 0) !== (a.lianban || 0)) return (b.lianban || 0) - (a.lianban || 0)
    return (b.changePct || 0) - (a.changePct || 0)
  }
  const mainPool = Array.from(byCode.values()).sort(heatSort)
  const strongQuota = Math.max(2, Math.round(limit / 4))
  const picked = mainPool.slice(0, Math.max(0, limit - strongQuota))
  const pickedCodes = new Set(picked.map((c) => c.code))
  let strongPicked = 0
  for (const it of strongPool) {
    if (picked.length >= limit) break
    add({ code: it.code, name: it.name }, '强势', { changePct: it.changePct, amount: it.amount })
    picked.push(byCode.get(it.code))
    pickedCodes.add(it.code)
    strongPicked++
  }
  for (const c of mainPool) {
    if (picked.length >= limit) break
    if (!pickedCodes.has(c.code)) {
      picked.push(c)
      pickedCodes.add(c.code)
    }
  }
  let candidates = picked

  // 4. 单连接一次读齐日线批量 + 名称；并行拉 duanxianxia 异动题材（内部带缓存/预算，不抛出）
  const specs = []
  for (const c of candidates) specs.push({ code: c.code, adjust: 'raw' })
  specs.push({ code: indexDbCode('000300'), adjust: 'idx' })
  const dxxPromise = fetchDxxThemes(candidates.map((c) => c.code), env.DXX_TOKEN || '', date)
  let tableData = new Map()
  let names = new Map()
  try {
    ({ bars: tableData, names } = await readBarsWithNames(env, specs, candidates.map((c) => c.code), 90))
  } catch { /* 回退现拉 */ }
  const dxxThemes = await dxxPromise

  const benchBars = tableData.get(indexDbCode('000300') + '|idx')
  let bench = { bars: benchBars }
  if (!bench.bars || bench.bars.length < 90) {
    const live = await fetchDaily(INDEXES['000300'], { attempts: 1, timeout: 4000 })
    bench = live || { bars: [] }
  }

  // 5. 缺失 K 线并行现拉（并发 6，共享总时长预算，避免上游不通时拖垮接口）
  const min = FACTOR_SPEC.window.breakout + FACTOR_SPEC.window.ret + 1
  const liveDeadline = Date.now() + 8000
  const liveBars = new Map()
  const missing = candidates.filter((c) => {
    const b = tableData.get(c.code + '|raw')
    return !(b && b.length >= min)
  })
  for (let i = 0; i < missing.length; i += 6) {
    if (Date.now() > liveDeadline) break
    await Promise.all(missing.slice(i, i + 6).map(async (c) => {
      if (Date.now() > liveDeadline) return
      const live = await fetchDaily(stockSecid(c.code), { attempts: 1, timeout: 4000 })
      if (live && live.bars.length >= min) liveBars.set(c.code, live.bars)
    }))
  }

  // 名称兜底并行补齐（stock_list 与池内名称都缺的少数标的）
  const needName = candidates.filter((c) => !names.get(c.code) && !c.name)
  await Promise.all(needName.map(async (c) => {
    const n = await fetchName(c.code)
    if (n) names.set(c.code, n)
  }))

  // 6. 逐标的算 K 线因子（表缓存优先，其次现拉结果）
  const rows = []
  for (const c of candidates) {
    let bars = tableData.get(c.code + '|raw')
    let source = bars && bars.length >= min ? 'table' : null
    if (!source && liveBars.has(c.code)) { bars = liveBars.get(c.code); source = 'live' }
    const name = names.get(c.code) || c.name || ''

    const factors = bars && bench.bars && bench.bars.length >= min
      ? computeKlineFactors(bars, bench.bars)
      : { breakout60: null, ret20: null, std20: null, independence: null, asOf: null }
    const indep = factors.independence
    const label = indep != null && indep > FACTOR_SPEC.thresholds.independence
      ? '独立走势'
      : ((c.lianban || 0) >= 2 ? '身位核心' : c.tags.includes('炸板') ? '退潮观察' : '普通')

    const dxx = dxxThemes.get(c.code)
    const reason = (dxx && dxx.topic) || thsReasons.get(c.code)
    const themes = reason ? reason.split('+').map((t) => t.trim()).filter(Boolean) : null

    rows.push({
      code: c.code,
      name,
      tags: c.tags,
      hotRank: c.hotRank || null,
      hotSources: c.hotSources || null,
      lianban: c.lianban || 0,
      firstSeal: c.firstSeal || null,
      industry: c.industry || '',
      themes,
      broken: c.broken || 0,
      changePct: c.changePct != null ? c.changePct : null,
      amount: c.amount != null ? c.amount : null,
      source,
      label,
      ...factors,
    })
  }

  // 展示按独立性降序（辨识度优先，无因子的保持选股顺序排后）
  rows.sort((a, b) => (b.independence ?? -Infinity) - (a.independence ?? -Infinity))

  const asOf = rows.find((r) => r.asOf)?.asOf || date
  return {
    status: 200,
    body: {
      ok: true,
      specVersion: FACTOR_SPEC.version,
      date,
      asOf,
      scanned: { zt: zt.length, zb: zb.length, hot: hotAgg.size, strong: strongPicked, hotBySource, hotFallback },
      hotAsOf,
      count: rows.length,
      rows,
    },
  }
}

export async function handleFeatRequest(request, env, url, ctx) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)

  if (url.pathname === '/api/feat/spec') return handleSpec()
  if (url.pathname === '/api/feat/factor') return await handleFactor(url, env)
  if (url.pathname === '/api/feat/candidates') return await handleCandidates(url, env, ctx)

  return json({ ok: false, error: '未知接口。可用：/api/feat/factor、/api/feat/candidates、/api/feat/spec' }, 404)
}
