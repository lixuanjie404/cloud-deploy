/**
 * 标的映射与资金确认（从 catalyst/mapping.mjs 平移，取数复用 workers/fetch/eastmoney.js）
 */
import { fetchBoardStocks, fetchPool, fetchMainFlow } from '../fetch/eastmoney.js'

export function matchBoard(name, boards) {
  const target = String(name || '').trim()
  if (!target) return null
  const exact = boards.find((b) => b.name === target)
  if (exact) return exact
  const contains = boards.filter((b) => b.name.includes(target) || target.includes(b.name))
  return contains.length === 1 ? contains[0] : null
}

export function confirmStatus(stock, ztMap, flowMap) {
  const zt = ztMap.get(stock.code)
  const flow = flowMap.get(stock.code) || 0
  if (zt && (zt.broken > 0 || zt.lianban >= 3)) {
    return { status: '已兑现', reason: '连板' + zt.lianban + '/炸板' + zt.broken + '次', flow }
  }
  if (zt && zt.lianban >= 1) {
    return { status: '已启动', reason: zt.lianban + '连板', flow }
  }
  if (flow > 0) {
    return { status: '待发酵', reason: '主力净流入', flow }
  }
  return { status: '观望', reason: '资金未确认', flow }
}

/**
 * 把 LLM 输出的板块映射到成分股并按资金状态确认
 * @param {Array<{code,name}>} boards 已匹配的板块（含 code）
 * @param {Map} ztMap 涨停池（code → {lianban,broken,...}）
 * @param {Map} flowMap 主力净额
 */
export async function mapAndConfirm(boards, ztMap, flowMap, maxPerBoard = 3) {
  // 并行拉取所有板块成分股（串行会让 8 个板块累积到上百秒）；限制最多 8 个板块
  const limited = boards.slice(0, 8)
  const groups = await Promise.all(limited.map(async (board) => {
    try {
      const stocks = await fetchBoardStocks(board.code)
      return stocks
        .filter((s) => s.chg > 0 && s.chg < 9.5)
        .sort((a, b) => a.chg - b.chg)
        .slice(0, maxPerBoard)
        .map((stock) => ({ ...stock, board: board.name, boardCode: board.code, ...confirmStatus(stock, ztMap, flowMap) }))
    } catch { return [] }
  }))
  const flat = groups.flat()
  const seen = new Set()
  return flat.filter((s) => {
    if (seen.has(s.code)) return false
    seen.add(s.code)
    return true
  })
}

/** 组装市场基础数据：涨停池 Map + 主力净额 Map */
export async function marketData(date) {
  const [pool, flow] = await Promise.all([
    fetchPool('zt', date),
    fetchMainFlow(),
  ])
  const ztMap = new Map()
  for (const it of pool) {
    ztMap.set(it.code, { lianban: it.lianban, broken: it.broken, firstSeal: it.firstSeal })
  }
  return { ztMap, flowMap: flow }
}
