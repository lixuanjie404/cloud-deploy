/**
 * 分时量能接口（Cloudflare Workers）
 *
 *   GET /api/intraday/amount?code=sh000001&days=2
 *
 * 背景：原「今日进度 · 量」内嵌的 duanxianxia 页面依赖 web.ifzq.gtimg.cn（腾讯分时），
 * 该域名现在返回 501 + WAF 跳转页，导致图表空白。这里改用东方财富分时接口，
 * 由 Worker 侧转发（顺带避开浏览器跨域与第三方 Cookie 限制）。
 */

const EM = 'https://push2.eastmoney.com/api/qt/stock/trends2/get'
const CODES = {
  sh000001: { secid: '1.000001', name: '上证指数' },
  sz399001: { secid: '0.399001', name: '深证成指' },
  sz399006: { secid: '0.399006', name: '创业板指' },
}
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

export async function handleIntradayRequest (request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)
  if (!url.pathname.startsWith('/api/intraday/amount')) {
    return json({ ok: false, error: '用法：/api/intraday/amount?code=sh000001&days=2' }, 404)
  }

  const code = url.searchParams.get('code') || 'sh000001'
  const meta = CODES[code]
  if (!meta) return json({ ok: false, error: `不支持的代码：${code}` }, 400)

  const daysNum = Number(url.searchParams.get('days') || 2)
  const ndays = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 5 ? daysNum : 2

  const target = EM +
    '?secid=' + encodeURIComponent(meta.secid) +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    '&ndays=' + ndays + '&iscr=0'

  let upstream
  try {
    upstream = await fetchWithRetry(target, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://quote.eastmoney.com/',
        Accept: 'application/json,text/plain,*/*',
      },
      cf: { cacheTtl: 20, cacheEverything: true },
    })
  } catch (err) {
    return json({ ok: false, error: `上游请求失败：${err.message}` }, 502)
  }

  if (!upstream.ok) return json({ ok: false, error: `上游返回 ${upstream.status}` }, 502)

  let payload
  try {
    payload = await upstream.json()
  } catch {
    return json({ ok: false, error: '上游返回非 JSON' }, 502)
  }

  const rows = payload && payload.data && payload.data.trends
  if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: '上游无分时数据' }, 404)

  const days = parseTrends(rows)

  // 分时接口只给当天，上一交易日的全天成交额另取日线
  let prevTotal = null
  let prevDate = null
  try {
    const dailyRes = await fetchWithRetry(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
        '?secid=' + encodeURIComponent(meta.secid) +
        '&fields1=f1,f2,f3,f4,f5,f6' +
        '&fields2=f51,f52,f53,f54,f55,f56,f57' +
        '&klt=101&fqt=0&lmt=2&end=20500101',
      { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, cf: { cacheTtl: 300, cacheEverything: true } },
    )
    if (dailyRes.ok) {
      const daily = await dailyRes.json()
      const list = (daily && daily.data && daily.data.klines) || []
      const today = days.length ? days[days.length - 1].date.replace(/-/g, '') : ''
      const prior = list.filter((row) => String(row).slice(0, 10) !== (days.length ? days[days.length - 1].date : ''))
      const pick = prior.length ? prior[prior.length - 1] : list.length ? list[list.length - 1] : null
      if (pick) {
        const cols = String(pick).split(',')
        const dayStr = cols[0]
        const amt = Number(cols[6])
        if (Number.isFinite(amt) && (!today || dayStr !== today)) {
          prevTotal = Number((amt / 1e8).toFixed(2))
          prevDate = dayStr
        }
      }
    }
  } catch {
    // 参照值取不到不影响主图
  }
  return json(
    {
      ok: true,
      code,
      name: meta.name,
      updatedAt: new Date().toISOString(),
      prevTotal,
      prevDate,
      days,
    },
    200,
    'public, max-age=20, s-maxage=30',
  )
}
