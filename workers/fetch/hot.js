/**
 * 四源热门人气股抓取（Cloudflare Workers）
 *
 * 东财人气榜（fetchHotRank）+ 同花顺热榜 + 雪球热股 + 淘股吧人气榜（1小时）。
 * 由每小时 Cron 拉取落 hot_stock 表；HTTP 读接口只读表（见 feat.js）。
 * 各源失败互不影响，返回 []。
 *
 * 统一口径：{ code: 6位数字, name, rank: 源内名次(1起), heat: 源内热度值 }
 */

import { fetchHotRank } from './eastmoney.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CODE = /^\d{6}$/

export const HOT_SOURCES = [
  { key: 'em', label: '东财' },
  { key: 'ths', label: '同花顺' },
  { key: 'xq', label: '雪球' },
  { key: 'tgb', label: '淘股吧' },
]

async function getJson(url, headers, timeout = 10000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 同花顺热榜（小时榜，全 A，按热度降序，前 100） */
export async function fetchThsHot() {
  try {
    const payload = await getJson(
      'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal',
      { 'User-Agent': UA, Referer: 'https://www.10jqka.com.cn/' },
    )
    const list = (payload && payload.data && payload.data.stock_list) || []
    return list
      .map((it, i) => ({ code: String(it.code), name: it.name || '', rank: i + 1, heat: Number(it.rate) || 0 }))
      .filter((x) => CODE.test(x.code))
  } catch (err) {
    console.log('[hot] 同花顺取数失败', err.message)
    return []
  }
}

/**
 * 雪球热股（匿名）：先访问 www.xueqiu.com/hq 拿 xq_a_token（首页只下发 acw_tc，不可用），
 * 再调 hot_stock 榜。榜单含港美股且每页固定约 8 条，翻页采集后按 symbol 前缀
 * 过滤出沪深京 A 股，按全局热度顺序重排名次。
 */
export async function fetchXueqiuHot() {
  try {
    const home = await fetch('https://www.xueqiu.com/hq', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    })
    const cookies = home.headers.getSetCookie().map((c) => c.split(';')[0])
    if (!cookies.some((c) => c.startsWith('xq_a_token='))) throw new Error('未取到 xq_a_token')
    const headers = { 'User-Agent': UA, Referer: 'https://xueqiu.com/hq', Cookie: cookies.join('; ') }
    const out = []
    const seen = new Set()
    for (let page = 1; page <= 15; page++) {
      const payload = await getJson(
        'https://stock.xueqiu.com/v5/stock/hot_stock/list.json?page=' + page + '&size=100&order=desc&order_by=value&_type=10&type=10',
        headers,
      )
      const items = (payload && payload.data && payload.data.items) || []
      if (!items.length) break
      for (const it of items) {
        const symbol = String(it.symbol || '')
        if (!/^(SH|SZ|BJ)\d{6}$/.test(symbol) || seen.has(symbol)) continue
        seen.add(symbol)
        out.push({ code: symbol.slice(2), name: it.name || '', rank: out.length + 1, heat: Number(it.value) || 0 })
      }
    }
    return out
  } catch (err) {
    console.log('[hot] 雪球取数失败', err.message)
    return []
  }
}

/** 淘股吧人气榜（1小时榜，含连板/上榜天数/人气值） */
export async function fetchTgbHot() {
  try {
    const payload = await getJson(
      'https://www.tgb.cn/new/nrnt/getNoticeStock?type=H',
      { 'User-Agent': UA, Referer: 'https://www.tgb.cn/new/nrnt/toPopularityBoard' },
    )
    const list = (payload && payload.dto) || []
    return list
      .map((it) => ({
        code: String(it.fullCode || '').slice(2),
        name: it.stockName || '',
        rank: Number(it.ranking) || 0,
        heat: Number(it.popularValue) || 0,
      }))
      .filter((x) => CODE.test(x.code) && x.rank > 0)
  } catch (err) {
    console.log('[hot] 淘股吧取数失败', err.message)
    return []
  }
}

/**
 * 并行拉四源，返回 [{ key, label, items }]；单源失败 items 为 []
 */
export async function fetchAllHot() {
  const [em, ths, xq, tgb] = await Promise.all([
    fetchHotRank(50).then((list) => list.map((it) => ({ code: it.code, name: '', rank: it.rank, heat: 0 }))),
    fetchThsHot(),
    fetchXueqiuHot(),
    fetchTgbHot(),
  ])
  const byKey = { em, ths, xq, tgb }
  return HOT_SOURCES.map((s) => ({ key: s.key, label: s.label, items: byKey[s.key] }))
}