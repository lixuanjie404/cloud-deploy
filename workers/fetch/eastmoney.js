/**
 * 东方财富行情 REST 封装（Cloudflare Workers）
 *
 * 数据源：push2his 日线（标的 + 指数，全历史），push2ex 情绪池（按 date 回拉）。
 * K 线类因子按需现拉全历史，不依赖逐日存快照。
 *
 * 与 workers/kline.js 的关系：kline.js 的 fetchEastmoneyDaily 是单票回退的窄口实现；
 * 本模块是因子计算用的通用封装，支持指数 secid 与更大历史长度。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REFERER = 'https://quote.eastmoney.com/'
const ZT_TOKEN = '7eea3edcaed734bea9cbfc24409ed989'

const HEADERS = { 'User-Agent': UA, Referer: REFERER }

/** 6 位标的代码 → 东财 secid（6 开头沪市，其余深市） */
export function stockSecid(code) {
  return (/^6\d{5}$/.test(code) ? '1.' : '0.') + code
}

/** 已知指数 secid（Independence 基准候选） */
export const INDEXES = {
  '000300': '1.000300', // 沪深300
  '000001': '1.000001', // 上证指数
  '399001': '0.399001', // 深证成指
  '399006': '0.399006', // 创业板指
}

/**
 * 指数 code → daily_bar 里 idx 序列的 code（如 idx_sh000300）
 * 用于因子优先读表；现拉仍用 INDEXES 的 secid。
 */
const INDEX_DB_CODE = {
  '000300': 'idx_sh000300',
  '000001': 'idx_sh000001',
  '000016': 'idx_sh000016',
  '000688': 'idx_sh000688',
  '000852': 'idx_sh000852',
  '000905': 'idx_sh000905',
  '399001': 'idx_sz399001',
  '399006': 'idx_sz399006',
}
export function indexDbCode(code) {
  return INDEX_DB_CODE[code] || code
}

function parseKlines(rows) {
  return rows.map(function (row) {
    const c = String(row).split(',')
    return {
      date: c[0],
      open: Number(c[1]),
      close: Number(c[2]),
      high: Number(c[3]),
      low: Number(c[4]),
      volume: Number(c[5]),
      amount: Number(c[6]),
    }
  }).filter(function (b) { return b.close > 0 })
}

/**
 * 拉取日线全历史（标的或指数）
 * @param {string} secid 东财 secid，如 '1.600127' / '1.000300'
 * @param {object} opt { limit, fqt, attempts, timeout } —— limit 默认 1000（实测返回全历史），
 *        fqt 0 不复权 / 2 前复权；attempts 重试次数默认 3；timeout 单次超时默认 15000ms
 * @returns {Promise<{bars:Array,name:string}|null>}
 */
export async function fetchDaily(secid, opt = {}) {
  // 实测：beg=0&end=20500101 时上游返回全历史，lmt 不截断，故用小值避免大响应
  const limit = opt.limit || 1000
  const fqt = opt.fqt === 2 ? 2 : 0
  const attempts = opt.attempts || 3
  const timeout = opt.timeout || 15000
  const target =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57' +
    '&klt=101&fqt=' + fqt +
    '&beg=0&end=20500101&lmt=' + limit

  let lastErr = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res
    try {
      res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(timeout) })
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue }
      const payload = await res.json()
      const data = payload && payload.data
      const rows = (data && data.klines) || []
      const bars = parseKlines(rows)
      if (bars.length) return { bars, name: data.name || '' }
      lastErr = new Error('空数据')
    } catch (err) {
      lastErr = err
    }
  }
  console.log('[eastmoney] 取数失败', secid, lastErr && lastErr.message)
  return null
}

/**
 * 按日期回拉情绪池（涨停/跌停/炸板）
 * @param {'zt'|'dt'|'zb'} kind
 * @param {string} date YYYYMMDD
 * @returns {Promise<Array>} 池内标的数组；休市日或无数据返回 []
 *
 * 注意：上游 data.qdate 恒为服务器当天，判断某日有无数据必须用 data.tc（总数）> 0。
 * 历史深度约 14 根日线，更早返回空。
 */
export async function fetchPool(kind, date) {
  const api = kind === 'dt' ? 'getTopicDTPool' : kind === 'zb' ? 'getTopicZBPool' : 'getTopicZTPool'
  const target =
    'https://push2ex.eastmoney.com/' + api +
    '?ut=' + ZT_TOKEN +
    '&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=' + encodeURIComponent(date)

  let res
  try {
    res = await fetch(target, { headers: HEADERS })
  } catch {
    return []
  }
  if (!res.ok) return []
  try {
    const payload = await res.json()
    const data = payload && payload.data
    if (!data || !data.tc || !Array.isArray(data.pool)) return []
    return data.pool.map(function (it) {
      return {
        code: it.c,
        name: it.n,
        market: it.m,
        price: it.p != null ? Number(it.p) / 1000 : null,
        changePct: Number(it.zdp),
        amount: Number(it.amount),
        turnover: Number(it.hs),
        lianban: Number(it.lbc || 0),
        firstSeal: it.fbt != null ? String(it.fbt) : null,
        lastSeal: it.lbt != null ? String(it.lbt) : null,
        sealFund: Number(it.fund || 0),
        broken: Number(it.zbc || 0),
        industry: it.hybk || '',
      }
    })
  } catch {
    return []
  }
}

/**
 * 东财人气榜（全市场热度前列）
 * @returns {Promise<Array<{code,name,rank}>>} 人气榜标的；失败返回 []
 */
export async function fetchHotRank(limit = 50) {
  const target = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList'
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38', marketType: '', pageNo: 1, pageSize: limit }),
    })
    if (!res.ok) return []
    const payload = await res.json()
    const list = (payload && payload.data) || []
    return list.map(function (it) {
      const sc = String(it.sc || '')
      return { code: sc.slice(2), rank: Number(it.rk) }
    }).filter((x) => /^\d{6}$/.test(x.code))
  } catch {
    return []
  }
}

/**
 * 全市场排行（clist，沪深京 A）：fid='f3' 涨幅榜 / 'f6' 成交额榜，降序
 * @returns {Promise<Array<{code,name,changePct,amount,turnover,rank}>>} 失败返回 []
 * changePct 为百分数（如 9.98），停牌等无值字段为 null
 */
export async function fetchRankList(fid = 'f3', pz = 100) {
  const target =
    'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=' + pz + '&po=1&np=1&fltt=2&invt=2&fid=' + fid +
    '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048' +
    '&fields=f3,f6,f8,f12,f14'
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return []
    const payload = await res.json()
    const diff = (payload && payload.data && payload.data.diff) || []
    const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    return diff
      .map((it, i) => ({
        code: String(it.f12),
        name: it.f14 || '',
        changePct: finite(it.f3),
        amount: finite(it.f6),
        turnover: finite(it.f8),
        rank: i + 1,
      }))
      .filter((x) => /^\d{6}$/.test(x.code))
  } catch (err) {
    console.log('[eastmoney] 排行取数失败', fid, err.message)
    return []
  }
}

/**
 * 查询单个标的名称（兜底：库里 stock_list 没有时用）
 * @param {string} code 6 位代码
 * @returns {Promise<string>} 名称，失败返回空串
 */
export async function fetchName(code) {
  const secid = stockSecid(code)
  const target =
    'https://push2.eastmoney.com/api/qt/stock/get' +
    '?secid=' + encodeURIComponent(secid) +
    '&fields=f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b'
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(4000) })
    if (!res.ok) return ''
    const payload = await res.json()
    return (payload && payload.data && payload.data.f58) || ''
  } catch {
    return ''
  }
}

/**
 * 概念板块列表（东财 push2 clist，板块 name/code）
 * @returns {Promise<Array<{code,name}>>}
 */
export async function fetchConceptBoards() {
  const base = 'https://push2.eastmoney.com/api/qt/clist/get' +
    '?po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A3&fields=f12,f14'
  const all = []
  let total = Infinity
  for (let pn = 1; all.length < total && pn <= 10; pn++) {
    let payload = null
    // 单页重试（本机 fetch 东财偶发断连，生产环境 Cloudflare 出网无此问题）
    for (let attempt = 0; attempt < 3 && !payload; attempt++) {
      try {
        const res = await fetch(base + '&pn=' + pn + '&pz=100', { headers: HEADERS, signal: AbortSignal.timeout(5000) })
        if (res.ok) payload = await res.json()
      } catch { /* retry */ }
      if (!payload && attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    }
    if (!payload) break
    const data = payload.data || {}
    total = Number(data.total) || 0
    const diff = data.diff || []
    if (!diff.length) break
    for (const d of diff) all.push({ code: d.f12, name: d.f14 })
    await new Promise((r) => setTimeout(r, 60))
  }
  const seen = new Set()
  return all.filter((b) => b.code && b.name && !seen.has(b.name) && seen.add(b.name))
}

/**
 * 单个概念板块的成分股（按涨幅排序）
 * @returns {Promise<Array<{code,name,chg,turnover}>>}
 */
export async function fetchBoardStocks(boardCode) {
  const target = 'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b%3A' + encodeURIComponent(boardCode) +
    '&fields=f12,f14,f3,f8'
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const payload = await res.json()
    const diff = (payload && payload.data && payload.data.diff) || []
    return diff.map((d) => ({
      code: d.f12, name: d.f14,
      chg: Number(d.f3) || 0, turnover: Number(d.f8) || 0,
    })).filter((s) => /^\d{6}$/.test(s.code))
  } catch {
    return []
  }
}

/**
 * 全市场主力净额（code → 净额）
 * @returns {Promise<Map<string,number>>}
 */
export async function fetchMainFlow() {
  const target = 'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f62' +
    '&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23&fields=f12,f14,f62'
  const map = new Map()
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return map
    const payload = await res.json()
    const diff = (payload && payload.data && payload.data.diff) || []
    for (const d of diff) map.set(d.f12, Number(d.f62) || 0)
  } catch { /* 降级为空 */ }
  return map
}

/**
 * 东财证券名称搜索（searchapi suggest，支持中文简称/拼音缩写）
 * 只返回沪深 A 股（含科创板/创业板）；网络失败返回 null（区别于无匹配的 []）
 * @returns {Promise<Array<{code,name}>|null>}
 */
export async function suggestStocks(input) {
  const q = String(input || '').trim()
  if (!q) return []
  const target = 'https://searchapi.eastmoney.com/api/suggest/get' +
    '?input=' + encodeURIComponent(q) + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10'
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const payload = await res.json()
    const rows = (payload && payload.QuotationCodeTable && payload.QuotationCodeTable.Data) || []
    const aTypes = new Set(['沪A', '深A', '科创板', '创业板'])
    const seen = new Set()
    return rows
      .filter((r) => aTypes.has(r.SecurityTypeName) && /^\d{6}$/.test(r.Code) && !seen.has(r.Code) && seen.add(r.Code))
      .map((r) => ({ code: r.Code, name: r.Name }))
  } catch {
    return null
  }
}

/**
 * 东财 F10 公司简介（主营一句话，消歧用）
 * @returns {Promise<string>} 简介文本；失败/无数据返回 ''
 */
export async function fetchCompanyProfile(code) {
  const target = 'https://datacenter.eastmoney.com/securities/api/data/v1/get' +
    '?reportName=RPT_F10_ORG_BASICINFO&columns=SECUCODE,SECURITY_CODE,ORG_NAME,ORG_PROFILE' +
    '&filter=' + encodeURIComponent(`(SECURITY_CODE="${code}")`) +
    '&pageSize=1&source=HSF10&client=PC'
  try {
    const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return ''
    const payload = await res.json()
    const row = payload && payload.result && payload.result.data && payload.result.data[0]
    return String((row && row.ORG_PROFILE) || '')
  } catch {
    return ''
  }
}
