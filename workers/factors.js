/**
 * 辨识度因子纯函数（Cloudflare Workers）
 *
 * 因子定义与阈值来自单一口径表 FACTOR_SPEC，JS 与 Prompt 共用同一份，禁止两处硬编码。
 * 本模块只做计算，不取数、不写库；输入为日线 bars 数组（date/open/close/high/low/volume/amount）。
 *
 * 对拍约定：收益用前复权口径；std 采用样本标准差 ddof=1（与 pandas 默认一致）；
 * 前高突破不含当日自身。
 */

/**
 * 单一因子口径表（JS 与 Prompt 共用事实源）
 * 变更阈值或定义时只改这里，并同步更新版本号、重跑对拍。
 */
export const FACTOR_SPEC = {
  version: '1.0.0',
  window: {
    breakout: 60,
    ret: 20,
    std: 20,
  },
  thresholds: {
    sole: 0.7,
    anchor: 0.8,
    independence: 1.5,
  },
  sentiment: {
    zhabanRateHigh: 0.35,
    promotionRateLow: 0.30,
  },
  definitions: {
    breakout: '最新收盘价 > 过去60根日线最高价（不含当日）',
    ret: '最近20根日线累计收益 = close[t]/close[t-20]-1',
    std: '最近20根日线日收益的样本标准差（ddof=1）',
    independence: '(标的20日累计收益 - 基准20日累计收益) / 标的20日收益标准差',
  },
}

/** 安全数值转换 */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 突破前高：最新收盘 > 过去 window 日最高价（不含当日）
 * @param {Array} bars 日线数组（按时间升序）
 * @param {number} window 回看日线根数，默认 60
 * @returns {boolean|null} 数据不足返回 null
 */
export function preHighBreak(bars, window = FACTOR_SPEC.window.breakout) {
  if (!Array.isArray(bars) || bars.length < window + 1) return null
  const last = num(bars[bars.length - 1].close)
  if (last == null) return null
  let highest = -Infinity
  for (let i = bars.length - 1 - window; i < bars.length - 1; i++) {
    const h = num(bars[i].high)
    if (h != null && h > highest) highest = h
  }
  return highest > -Infinity ? last > highest : null
}

/**
 * 区间累计收益：close[末] / close[末-n] - 1
 * @param {Array} bars 日线数组
 * @param {number} n 日线根数，默认 20
 * @returns {number|null} 数据不足或基准价为 0 返回 null
 */
export function retN(bars, n = FACTOR_SPEC.window.ret) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null
  const last = num(bars[bars.length - 1].close)
  const base = num(bars[bars.length - 1 - n].close)
  if (last == null || base == null || base === 0) return null
  return last / base - 1
}

/**
 * 日收益序列：长度 = bars.length - 1
 */
function dailyReturns(bars) {
  const out = []
  for (let i = 1; i < bars.length; i++) {
    const cur = num(bars[i].close)
    const prev = num(bars[i - 1].close)
    if (cur == null || prev == null || prev === 0) continue
    out.push(cur / prev - 1)
  }
  return out
}

/**
 * 日收益样本标准差（ddof=1）
 * @param {Array} bars 日线数组
 * @param {number} n 取最近 n 个日收益，默认 20
 * @returns {number|null}
 */
export function stdN(bars, n = FACTOR_SPEC.window.std) {
  const rets = dailyReturns(bars).slice(-n)
  if (rets.length < 2) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  let sq = 0
  for (const r of rets) sq += (r - mean) * (r - mean)
  return Math.sqrt(sq / (rets.length - 1))
}

/**
 * 指数独立性：(标的 n 日收益 - 基准 n 日收益) / 标的 n 日收益标准差
 * @param {Array} stockBars 标的日线
 * @param {Array} indexBars 基准指数日线
 * @param {number} n 日线根数，默认 20
 * @returns {number|null}
 */
export function independence(stockBars, indexBars, n = FACTOR_SPEC.window.ret) {
  const rs = retN(stockBars, n)
  const ri = retN(indexBars, n)
  const sd = stdN(stockBars, n)
  if (rs == null || ri == null || sd == null || sd === 0) return null
  return (rs - ri) / sd
}

/**
 * 汇总单只标的的 K 线类因子（MVP 范围）
 * @param {Array} bars 标的日线
 * @param {Array} benchBars 基准指数日线
 * @returns {object} 因子对象，缺失项为 null
 */
export function computeKlineFactors(bars, benchBars) {
  return {
    breakout60: preHighBreak(bars),
    ret20: retN(bars),
    std20: stdN(bars),
    independence: independence(bars, benchBars),
    asOf: Array.isArray(bars) && bars.length ? bars[bars.length - 1].date : null,
  }
}
