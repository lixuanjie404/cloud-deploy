/**
 * 分时量能接口（Cloudflare Workers）
 *
 *   GET /api/intraday/amount
 *
 * 返回「沪深两市合计」的分时成交额（口径与原 duanxianxia 量能页一致：
 * 昨日量能 14421 亿 = 上证 6427.52 + 深证 7993.x）。单市数据不足以代表
 * 「量」，所以这里固定合并两个市场，不再支持单代码查询。
 *
 * 数据源：东方财富分时接口（Worker 侧转发，带 UA/Referer 与一次重试）；
 * 上一交易日全天成交额取自东方财富日线接口。
 */

const EM = 'https://push2.eastmoney.com/api/qt/stock/trends2/get'
const EM_DAILY = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const MARKETS = [
  { secid: '1.000001', name: '上证指数' },
  { secid: '0.399001', name: '深证成指' },
]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

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

/** 上游偶发断连，重试一次更稳 */
async function fetchWithRetry (url, init, attempts) {
  const total = attempts || 2
  let lastErr = null
  for (let i = 0; i < total; i++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      lastErr = new Error('上游返回 ' + res.status)
    } catch (err) {
      lastErr = err
    }
    if (i < total - 1) await new Promise((r) => setTimeout(r, 250))
  }
  throw lastErr || new Error('上游请求失败')
}

/** 一行样例：2026-10-22 09:30,3714.48,3714.48,3714.48,3714.48,3228780,5179731200.00,3715.890 */
function parseTrends (rows) {
  const byDate = new Map()
  for (const row of rows) {
    const parts = String(row).split(',')
    if (parts.length < 7) continue
    const stamp = parts[0].trim()
    const space = stamp.indexOf(' ')
    if (space < 0) continue
    const date = stamp.slice(0, space)
    const time = stamp.slice(space + 1, space + 6)
    const amount = Number(parts[6])
    if (!Number.isFinite(amount)) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push({ time, amount: Number((amount / 1e8).toFixed(3)) })
  }

  const days = []
  for (const [date, points] of byDate) {
    let sum = 0
    const cumulative = points.map((p) => {
      sum += p.amount
      return Number(sum.toFixed(2))
    })
    days.push({ date, times: points.map((p) => p.time), minutes: points.map((p) => p.amount), cumulative })
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1))
  return days
}

async function fetchMarketIntraday (secid) {
  const target = EM +
    '?secid=' + encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    '&ndays=1&iscr=0'

  const res = await fetchWithRetry(target, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://quote.eastmoney.com/',
      Accept: 'application/json,text/plain,*/*',
    },
    cf: { cacheTtl: 20, cacheEverything: true },
  })
  if (!res.ok) throw new Error(`上游返回 ${res.status}`)

  const payload = await res.json()
  const rows = payload && payload.data && payload.data.trends
  if (!Array.isArray(rows) || !rows.length) throw new Error('上游无分时数据')
  return parseTrends(rows)
}

/** 上一交易日的全天成交额（亿） */
async function fetchPrevDayTotal (secid, todayDate) {
  const target = EM_DAILY +
    '?secid=' + encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57' +
    '&klt=101&fqt=0&lmt=2&end=20500101'

  const res = await fetchWithRetry(target, {
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    cf: { cacheTtl: 300, cacheEverything: true },
  })
  if (!res.ok) return null

  const daily = await res.json()
  const list = (daily && daily.data && daily.data.klines) || []
  const prior = list.filter((row) => String(row).slice(0, 10) !== todayDate)
  const pick = prior.length ? prior[prior.length - 1] : null
  if (!pick) return null

  const cols = String(pick).split(',')
  const amt = Number(cols[6])
  if (!Number.isFinite(amt) || cols[0] === todayDate) return null
  return { date: cols[0], total: Number((amt / 1e8).toFixed(2)) }
}

export async function handleIntradayRequest (request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)
  if (!url.pathname.startsWith('/api/intraday/amount')) {
    return json({ ok: false, error: '用法：/api/intraday/amount' }, 404)
  }

  let marketDays
  try {
    marketDays = await Promise.all(MARKETS.map((m) => fetchMarketIntraday(m.secid)))
  } catch (err) {
    return json({ ok: false, error: `上游请求失败：${err.message}` }, 502)
  }

  // 基准 = 两个市场里最新的日期（正常情况下两者相同）
  const latestDate = marketDays
    .map((d) => (d.length ? d[d.length - 1].date : ''))
    .sort()
    .pop()

  // 按时间对齐后逐分钟求和
  const buckets = new Map()
  marketDays.forEach((days) => {
    const day = days.find((d) => d.date === latestDate)
    if (!day) return
    day.times.forEach((time, i) => {
      if (!buckets.has(time)) buckets.set(time, 0)
      buckets.set(time, buckets.get(time) + day.minutes[i])
    })
  })

  const times = [...buckets.keys()].sort()
  let sum = 0
  const minutes = times.map((t) => {
    sum += buckets.get(t)
    return Number(sum.toFixed(2))
  })
  const cumulative = minutes.map((v) => Number(v.toFixed(2)))

  let prevTotal = null
  let prevDate = null
  try {
    const prevs = await Promise.all(MARKETS.map((m) => fetchPrevDayTotal(m.secid, latestDate)))
    const valid = prevs.filter((p) => p && p.total != null)
    if (valid.length === MARKETS.length) {
      prevDate = valid[0].date
      prevTotal = Number(valid.reduce((s, p) => s + p.total, 0).toFixed(2))
    }
  } catch {
    // 参照值取不到不影响主图
  }

  return json(
    {
      ok: true,
      code: 'sh000001+sz399001',
      name: '沪深两市',
      updatedAt: new Date().toISOString(),
      prevTotal,
      prevDate,
      days: [{ date: latestDate, times, minutes, cumulative }],
    },
    200,
    'public, max-age=20, s-maxage=30',
  )
}
