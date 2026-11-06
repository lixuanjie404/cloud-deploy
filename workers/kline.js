/**
 * K 线只读接口（Cloudflare Workers）
 *
 *   GET /api/kline/:code?days=120&adjust=raw
 *
 * 与 workers/db.js 的关系：db.js 是通用表浏览器，这里针对日线场景做窄口查询，
 * 只读 daily_bar，只认 6 位代码 + raw/hfq 两种口径。
 *
 * 连接方式：
 *   - 生产：展开 env.HYPERDRIVE 绑定对象直接作为连接参数
 *   - 本地：从 DB_* / MYSQL_* 拼 URI（.dev.vars 里已有 MYSQL_*）
 */

import { createConnection } from 'mysql2/promise'

const CODE = /^\d{6}$/
const ADJUSTS = new Set(['raw', 'hfq'])
const MAX_DAYS = 300
const DEFAULT_DAYS = 120

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

export function connectionOptions(env) {
  if (env.HYPERDRIVE && env.HYPERDRIVE.host) {
    // Hyperdrive 绑定字段本身就是 mysql2 的连接参数，直接展开即可
    const opts = {
      ...env.HYPERDRIVE,
      disableEval: true,
      dateStrings: true,
      connectTimeout: 10000,
    }
    // 本地模拟的 Hyperdrive 绑定可能不带库名，用环境变量补上
    const database = opts.database || env.DB_NAME || env.MYSQL_DATABASE
    if (database) opts.database = database
    return opts
  }

  const host = env.DB_HOST || env.MYSQL_HOST
  if (!host) return null

  const port = Number(env.DB_PORT || env.MYSQL_PORT) || 3306
  const database = env.DB_NAME || env.MYSQL_DATABASE
  const uri =
    'mysql://' +
    encodeURIComponent(env.DB_USER || env.MYSQL_USERNAME) +
    ':' +
    encodeURIComponent(env.DB_PASSWORD || env.MYSQL_PASSWORD) +
    '@' +
    host +
    ':' +
    port +
    '/' +
    database

  return {
    uri,
    ssl: { rejectUnauthorized: env.DB_SSL_INSECURE !== 'on' },
    disableEval: true,
    dateStrings: true,
    connectTimeout: 10000,
  }
}

/** MySQL 未同步的代码回退到东方财富日线（fqt=0 与 daily_bar 的 raw 口径一致） */
async function fetchEastmoneyDaily (code, days) {
  const secid = /^6\d{5}$/.test(code) ? '1.' + code : '0.' + code
  const target =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57' +
    '&klt=101&fqt=0&lmt=' + Math.min(days, 300) + '&end=20500101'

  let res
  try {
    res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    })
    if (!res.ok) { console.log('[kline-fallback] 上游', res.status); return null }
    const body = await res.text()
    console.log('[kline-fallback] body:', body.slice(0, 150))
    const payload = JSON.parse(body)
    const rows = (payload && payload.data && payload.data.klines) || []
    console.log('[kline-fallback] rc', payload.rc, 'rows', rows.length)
    const bars = rows.map(function (row) {
      const cols = String(row).split(',')
      return {
        date: cols[0],
        open: Number(cols[1]),
        high: Number(cols[3]),
        low: Number(cols[4]),
        close: Number(cols[2]),
        volume: Number(cols[5]),
        amount: Number(cols[6]),
      }
    }).filter(function (b) { return b.close > 0 })
    return bars.length ? bars : null
  } catch {
    return null
  }
}

function intParam(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

export async function handleKlineRequest(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)

  const m = url.pathname.match(/^\/api\/kline\/([^/]+)$/)
  if (!m) return json({ ok: false, error: '用法：/api/kline/:code?days=120&adjust=raw' }, 404)

  const code = decodeURIComponent(m[1])
  if (!CODE.test(code)) return json({ ok: false, error: '股票代码需为 6 位数字' }, 400)

  const days = intParam(url.searchParams.get('days'), DEFAULT_DAYS, 10, MAX_DAYS)
  if (days === null) return json({ ok: false, error: `days 需为 10-${MAX_DAYS} 的整数` }, 400)

  const adjust = url.searchParams.get('adjust') || 'raw'
  if (!ADJUSTS.has(adjust)) return json({ ok: false, error: 'adjust 仅支持 raw 或 hfq' }, 400)

  const opts = connectionOptions(env)
  if (!opts) {
    return json({ ok: false, error: '未配置数据库连接（HYPERDRIVE 或 DB_* / MYSQL_*）' }, 503)
  }

  let conn
  try {
    conn = await createConnection(opts)
  } catch (err) {
    return json({ ok: false, error: `连接失败：${err.code || err.message}` }, 502)
  }

  try {
    const [rows] = await conn.query(
      `SELECT trade_date, open, high, low, close, volume, amount
         FROM daily_bar
        WHERE code = ? AND adjust = ? AND close > 0
        ORDER BY trade_date DESC
        LIMIT ?`,
      [code, adjust, days],
    )

    if (!rows.length) {
      // MySQL 未同步该代码时，回退到东方财富日线接口，保证任意代码可用
      const fallback = await fetchEastmoneyDaily(code, days)
      if (fallback) {
        // 回退路径也要给 latest，前端弹窗的日线 tab 会读它
        const lastBar = fallback[fallback.length - 1]
        const prevBar = fallback.length > 1 ? fallback[fallback.length - 2] : null
        const changePct = prevBar
          ? Number((((lastBar.close - prevBar.close) / prevBar.close) * 100).toFixed(2))
          : null
        return json(
          {
            ok: true,
            code,
            adjust,
            count: fallback.length,
            range: { from: fallback[0].date, to: lastBar.date },
            latest: { date: lastBar.date, close: lastBar.close, changePct, volume: lastBar.volume },
            source: 'eastmoney',
            bars: fallback,
          },
          200,
          'public, max-age=60, s-maxage=120',
        )
      }
      return json({ ok: false, error: `未找到 ${code} 的 ${adjust} 日线数据` }, 404)
    }

    const bars = rows
      .slice()
      .reverse()
      .map((r) => {
        const date = String(r.trade_date).slice(0, 10)
        return {
          date,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
          amount: Number(r.amount),
        }
      })

    const last = bars[bars.length - 1]
    const prev = bars.length > 1 ? bars[bars.length - 2] : null
    const change = prev ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(2)) : null

    return json(
      {
        ok: true,
        code,
        adjust,
        count: bars.length,
        range: { from: bars[0].date, to: last.date },
        latest: { date: last.date, close: last.close, changePct: change, volume: last.volume },
        bars,
      },
      200,
      'public, max-age=60, s-maxage=120',
    )
  } catch (err) {
    return json({ ok: false, error: `查询失败：${err.code || err.message}` }, 500)
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}
