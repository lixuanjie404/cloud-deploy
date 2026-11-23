// 标的映射：LLM 只输出板块名，代码由东财概念成分股回填并校验
const EM_HEADERS = { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }
const UT = '7eea3edcaed734bea9cbfc24409ed989'

async function getJson(url) {
  const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchConceptBoards() {
  const base = 'https://push2.eastmoney.com/api/qt/clist/get'
    + '?po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A3&fields=f12,f14'
  const all = []
  let total = Infinity
  for (let pn = 1; all.length < total && pn <= 10; pn++) {
    const data = await getJson(`${base}&pn=${pn}&pz=100`)
    total = Number(data?.data?.total) || 0
    const diff = data?.data?.diff || []
    if (!diff.length) break
    all.push(...diff.map((d) => ({ code: d.f12, name: d.f14 })))
    await new Promise((r) => setTimeout(r, 100))
  }
  const seen = new Set()
  return all.filter((b) => b.code && b.name && !seen.has(b.name) && seen.add(b.name))
}

export function matchBoard(name, boards) {
  const target = String(name || '').trim()
  if (!target) return null
  const exact = boards.find((b) => b.name === target)
  if (exact) return exact
  const contains = boards.filter((b) => b.name.includes(target) || target.includes(b.name))
  return contains.length === 1 ? contains[0] : null
}

export async function fetchBoardStocks(boardCode) {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=1&pz=300&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b%3A${boardCode}&fields=f12,f14,f3,f8`
  const data = await getJson(url)
  return (data?.data?.diff || []).map((d) => ({
    code: d.f12,
    name: d.f14,
    chg: Number(d.f3) || 0,
    turnover: Number(d.f8) || 0,
  })).filter((s) => /^\d{6}$/.test(s.code))
}

export async function fetchZTPool(date) {
  const ymd = String(date || new Date().toISOString().slice(0, 10)).replace(/-/g, '')
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=wz.ztzt`
    + `&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=${ymd}`
  const data = await getJson(url)
  const map = new Map()
  for (const s of data?.data?.pool || []) {
    map.set(s.c, {
      lbc: Number(s.lbc) || 0,
      zbc: Number(s.zbc) || 0,
      hs: Number(s.hs) || 0,
      fund: Number(s.fund) || 0,
      firstSeal: s.fbt,
      lastSeal: s.lbt,
    })
  }
  return map
}

export async function fetchMainFlow() {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + '?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f62'
    + '&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23&fields=f12,f14,f62'
  const data = await getJson(url)
  const map = new Map()
  for (const d of data?.data?.diff || []) {
    map.set(d.f12, Number(d.f62) || 0)
  }
  return map
}

export function confirmStatus(stock, ztMap, flowMap) {
  const zt = ztMap.get(stock.code)
  const flow = flowMap.get(stock.code) || 0
  if (zt && (zt.zbc > 0 || zt.lbc >= 3)) {
    return { status: '已兑现', reason: `连板${zt.lbc}/炸板${zt.zbc}次`, flow }
  }
  if (zt && zt.lbc >= 1) {
    return { status: '已启动', reason: `${zt.lbc}连板`, flow }
  }
  if (flow > 0) {
    return { status: '待发酵', reason: '主力净流入', flow }
  }
  return { status: '观望', reason: '资金未确认', flow }
}

export async function mapAndConfirm(boards, ztMap, flowMap, maxPerBoard = 3) {
  const result = []
  for (const board of boards) {
    try {
      const stocks = await fetchBoardStocks(board.code)
      // 优先小盘 + 当日涨幅温和（避免一字板），再取前 N
      const picked = stocks
        .filter((s) => s.chg > 0 && s.chg < 9.5)
        .sort((a, b) => a.chg - b.chg)
        .slice(0, maxPerBoard)
      for (const stock of picked) {
        result.push({ ...stock, board: board.name, boardCode: board.code, ...confirmStatus(stock, ztMap, flowMap) })
      }
    } catch (err) {
      console.error(`[mapping] 板块 ${board.name} 成分股拉取失败: ${String(err.message || err).slice(0, 120)}`)
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  // 同一只股票只保留一次，优先「待发酵/已启动」
  const seen = new Set()
  return result.filter((s) => {
    if (seen.has(s.code)) return false
    seen.add(s.code)
    return true
  }).sort((a, b) => {
    const rank = { 待发酵: 0, 已启动: 1, 已兑现: 2, 观望: 3 }
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
  })
}
