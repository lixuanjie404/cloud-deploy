/**
 * 定时批量拉取日线并落表（Cloudflare Workers Cron）
 *
 * 触发：wrangler.jsonc triggers.crons
 *   - '5 7 * * 1-5'（07:05 UTC ≈ 15:05 北京，周一至周五）：日线增量落表
 *   - '0 * * * *'（每小时）：四源热门人气股（东财/同花顺/雪球/淘股吧）落 hot_stock
 * 催化分析（analyze/index.mjs）提取标的后也复用 pullOne 异步补拉日线；
 * HTTP 读接口（db/kline/intraday/feat）保持只读。
 *
 * 数据口径：
 *   - watchlist 标的：adjust = 'raw'
 *   - 基准指数：adjust = 'idx'
 *
 * 两种模式：
 *   - env.BACKFILL === 'on'：全量灌历史（首次建库用）
 *   - 默认：增量，仅 upsert 最近 UPSERT_TAIL 根（幂等，重复无害）
 */

import { fetchDaily, INDEXES, stockSecid, indexDbCode } from './fetch/eastmoney.js'
import { fetchAllHot } from './fetch/hot.js'
import { upsertDailyBars, upsertHotStocks } from './store.js'

function listOf(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 批量拉取单个标的并落表 */
export async function pullOne(env, code, adjust, secid, tail) {
  const data = await fetchDaily(secid)
  if (!data) {
    console.log('[cron] 取数失败', code, adjust)
    return { code, adjust, ok: false, rows: 0 }
  }
  const bars = tail > 0 && data.bars.length > tail ? data.bars.slice(-tail) : data.bars
  try {
    const rows = await upsertDailyBars(env, code, adjust, bars)
    console.log('[cron] 落表', code, adjust, rows, '最新', bars[bars.length - 1].date)
    return { code, adjust, ok: true, rows }
  } catch (err) {
    console.log('[cron] 写库失败', code, adjust, err.code || err.message)
    return { code, adjust, ok: false, rows: 0, error: String(err.code || err.message) }
  }
}

/**
 * 每小时：并行拉四源热门人气股并整源刷新 hot_stock（单源失败保留旧数据）
 */
export async function pullHot(env) {
  const started = Date.now()
  const sources = await fetchAllHot()
  const results = []
  for (const s of sources) {
    if (!s.items.length) {
      results.push({ source: s.key, ok: false, rows: 0 })
      continue
    }
    try {
      const rows = await upsertHotStocks(env, s.key, s.items)
      results.push({ source: s.key, ok: true, rows })
    } catch (err) {
      console.log('[cron] 热榜写库失败', s.key, err.code || err.message)
      results.push({ source: s.key, ok: false, rows: 0, error: String(err.code || err.message) })
    }
  }
  const ok = results.filter((r) => r.ok).length
  console.log('[cron] 热榜完成 成功', ok + '/' + results.length, '耗时', (Date.now() - started) + 'ms',
    results.map((r) => r.source + ':' + r.rows).join(' '))
  return results
}

/**
 * Cron 入口：按触发器分发——每小时热榜 / 每日日线批量落表
 * 可通过 controller.cron === 'BACKFILL' 或 env.BACKFILL === 'on' 切换全量模式
 */
export async function scheduled(controller, env, ctx) {
  const cron = controller && controller.cron
  if (cron === '0 * * * *' || cron === 'HOT') return pullHot(env)

  const started = Date.now()
  const watchlist = listOf(env.WATCHLIST)
  const indexes = listOf(env.INDEX_CODES)
  const backfill = env.BACKFILL === 'on' || (controller && controller.cron === 'BACKFILL')
  const tail = backfill ? 0 : Math.max(60, Number(env.UPSERT_TAIL) || 120)

  if (!watchlist.length && !indexes.length) {
    console.log('[cron] 未配置 WATCHLIST / INDEX_CODES，跳过')
    return
  }

  const results = []

  for (const code of watchlist) {
    if (!/^\d{6}$/.test(code)) { console.log('[cron] 非法代码跳过', code); continue }
    results.push(await pullOne(env, code, 'raw', stockSecid(code), tail))
  }

  for (const code of indexes) {
    if (!/^\d{6}$/.test(code)) { console.log('[cron] 非法指数代码跳过', code); continue }
    // 落表 code 必须与读侧一致（indexDbCode → idx_sh000300），否则因子接口读的那组永远不更新
    const dbCode = indexDbCode(code) || code
    results.push(await pullOne(env, dbCode, 'idx', INDEXES[code] || stockSecid(code), tail))
  }

  const ok = results.filter((r) => r.ok).length
  console.log('[cron] 完成', mode(backfill), '成功', ok + '/' + results.length, '耗时', (Date.now() - started) + 'ms')
}

function mode(backfill) {
  return backfill ? '全量' : '增量'
}

/** 供本地 test-scheduled 与诊断复用的导出（不暴露 HTTP） */
export async function runBackfill(env) {
  const watchlist = listOf(env.WATCHLIST)
  const indexes = listOf(env.INDEX_CODES)
  const results = []
  for (const code of watchlist) {
    if (/^\d{6}$/.test(code)) results.push(await pullOne(env, code, 'raw', stockSecid(code), 0))
  }
  for (const code of indexes) {
    if (/^\d{6}$/.test(code)) results.push(await pullOne(env, indexDbCode(code) || code, 'idx', INDEXES[code] || stockSecid(code), 0))
  }
  return results
}
