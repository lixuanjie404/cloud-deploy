/**
 * 日线补全（后台异步，不阻塞 HTTP 响应）
 *
 * 读接口（feat.js）读表后发现两类缺口，交给这里在 ctx.waitUntil 里补：
 *   - 缺失：表内无数据或不足 minBars 根 → 全量拉取并落表（fetchDaily 默认返回全历史）
 *   - 过期：表内最新日期早于参照日期 → 增量补尾：只落 参照日期 ≥ trade_date ≥ 表内最新日 的那几根
 *     （含表内最新日本身，刷新当日盘中变动的那根），与 cron 的 UPSERT_TAIL 语义一致
 *
 * 保护：
 *   - 冷却：同一序列补全成功后 COOLDOWN_MS 内不再补；失败不进冷却，下一次请求即重试
 *   - 并发 6 + 总时长预算，超时即停，剩余留给下一次请求
 *   - 只处理 6 位代码，写入走 store.upsertDailyBars（幂等 upsert）
 * 写入仅发生在后台任务（ctx.waitUntil）或 Cron 内；响应本身只用表内已有数据。
 */

import { fetchDaily, INDEXES, stockSecid, indexDbCode } from './fetch/eastmoney.js'
import { upsertDailyBars } from './store.js'

const CODE = /^\d{6}$/
const COOLDOWN_MS = 10 * 60 * 1000   // 成功后的冷却
const RETRY_MS = 30 * 1000            // 失败后的最短重试间隔（避免上游持续断连时每 15s 打一轮）
const CONCURRENCY = 6
const BUDGET_MS = 25000
const lastTry = new Map()   // key → { at, ok }

function secidOf(item) {
  if (item.adjust === 'idx') return INDEXES[item.code] || stockSecid(item.code)
  return stockSecid(item.code)
}

/** 表内 code：指数走 idx_shXXXXXX 映射，标的即 6 位代码 */
export function dbCodeOf(code, adjust) {
  return adjust === 'idx' ? indexDbCode(code) : code
}

function inCooldown(code, adjust) {
  const last = lastTry.get(code + '|' + adjust)
  if (!last) return false
  return Date.now() - last.at < (last.ok ? COOLDOWN_MS : RETRY_MS)
}

/**
 * 对比表内数据，得出需要补全的序列
 * @param {Map<string, Array>} tableData readDailyBarsBatch 的结果（key = dbCode|adjust）
 * @param {Array<{code,adjust}>} specs 逻辑代码（指数为 6 位码 + 'idx'）
 * @param {string} refDate 'YYYY-MM-DD' 参照最新交易日
 * @param {number} minBars 因子所需最少根数
 * @returns {{missing:Array, stale:Array, refDate:string}}
 */
export function diffBars(tableData, specs, refDate, minBars) {
  const missing = []
  const stale = []
  for (const s of specs) {
    if (!CODE.test(s.code)) continue
    const bars = tableData.get(dbCodeOf(s.code, s.adjust) + '|' + s.adjust) || []
    if (bars.length < minBars) {
      missing.push({ code: s.code, adjust: s.adjust, secid: secidOf(s) })
    } else if (refDate && bars[bars.length - 1].date < refDate) {
      stale.push({ code: s.code, adjust: s.adjust, secid: secidOf(s), lastDate: bars[bars.length - 1].date })
    }
  }
  return { missing, stale, refDate }
}

/** 表内各序列最新日期的最大值，作为“当前应到的交易日”参照 */
export function latestBarDate(tableData) {
  let latest = ''
  for (const bars of tableData.values()) {
    if (bars.length) {
      const d = bars[bars.length - 1].date
      if (d > latest) latest = d
    }
  }
  return latest || null
}

/**
 * 执行补全：缺失全量落表，过期只落增量尾部
 * @returns {Promise<{ok:number, fail:number, skipped:number}>}
 */
export async function runBarFill(env, missing, stale, opt = {}) {
  const now = Date.now()
  const deadline = now + (opt.budgetMs || BUDGET_MS)
  const jobs = []
  for (const it of missing) {
    if (inCooldown(it.code, it.adjust)) continue
    jobs.push({ ...it, mode: 'full' })
  }
  for (const it of stale) {
    if (inCooldown(it.code, it.adjust)) continue
    jobs.push({ ...it, mode: 'tail' })
  }
  const result = { ok: 0, fail: 0, skipped: missing.length + stale.length - jobs.length }
  if (!jobs.length) return result

  // 基准指数优先，其余按入参顺序；并发受 CONCURRENCY 限制
  jobs.sort((a, b) => (a.adjust === 'idx' ? 0 : 1) - (b.adjust === 'idx' ? 0 : 1))
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    if (Date.now() > deadline) { result.skipped += jobs.length - i; break }
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (job) => {
      const data = await fetchDaily(job.secid, { attempts: 2, timeout: 8000 })
      if (!data || !data.bars.length) {
        result.fail++
        lastTry.set(job.code + '|' + job.adjust, { at: Date.now(), ok: false })
        return
      }
      const bars = job.mode === 'tail'
        ? data.bars.filter((b) => b.date >= job.lastDate)
        : data.bars
      if (!bars.length) {
        result.fail++
        lastTry.set(job.code + '|' + job.adjust, { at: Date.now(), ok: false })
        return
      }
      try {
        await upsertDailyBars(env, dbCodeOf(job.code, job.adjust), job.adjust, bars)
        result.ok++
        // 成功进长冷却；失败进短冷却（见 inCooldown），上游恢复后下一次请求就能补上
        lastTry.set(job.code + '|' + job.adjust, { at: Date.now(), ok: true })
        console.log('[backfill]', job.mode, job.code, job.adjust, bars.length, '根, 最新', bars[bars.length - 1].date)
      } catch (err) {
        result.fail++
        lastTry.set(job.code + '|' + job.adjust, { at: Date.now(), ok: false })
        console.log('[backfill] 写库失败', job.code, err.code || err.message)
      }
    }))
  }
  return result
}

/**
 * 在后台调度补全：有 ctx.waitUntil 就异步，否则直接 await（本地脚本/测试用）
 * @returns {Promise<object>|undefined}
 */
export function scheduleBackfill(env, ctx, missing, stale) {
  if (!missing.length && !stale.length) return undefined
  const task = runBarFill(env, missing, stale)
    .then((r) => { console.log('[backfill] 完成', JSON.stringify(r)); return r })
    .catch((err) => { console.log('[backfill] 异常', err.message) })
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task)
    return undefined
  }
  return task
}
