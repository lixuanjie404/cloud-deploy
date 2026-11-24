/**
 * duanxianxia 个股异动解析代理（Cloudflare Workers）
 *
 * 上游 GET https://x.duanxianxia.cn/req/getStockSearch/:code（Bearer token，env.DXX_TOKEN）。
 * 响应 yidong: [{date, expound}]，expound 形如「题材1+题材2|1、要点…|2、要点…」，
 * 只取第一个「|」段（简短炒作题材描述），按 date 取最新一条。
 *
 * 免费账号有每日次数限制（403=当日额度用完）：
 * - Workers Cache 按 date+code 缓存，命中题材缓 6h、无题材缓 1h，跨请求省额度；
 * - 每次调用设现拉预算，403 即停；未覆盖的标的由调用方回退同花顺涨停解析。
 * token 约 3 天过期（JWT exp），失效需更新 .dev.vars / wrangler secret。
 */

const BASE = 'https://x.duanxianxia.cn'
const LIVE_BUDGET = 8

/**
 * 批量取个股最新异动题材
 * @param {string[]} codes 6 位代码
 * @param {string} token Bearer token（空则直接返回空 Map）
 * @param {string} date YYYYMMDD，仅作缓存键（隔日自动失效）
 * @returns {Promise<Map<string, {topic:string, date:string}>>}
 */
export async function fetchDxxThemes(codes, token, date) {
  const out = new Map()
  if (!token || !codes.length) return out
  const cache = caches.default
  const cacheKey = (code) => new Request('https://dxx-theme.cache/' + date + '/' + code)

  const miss = []
  const hits = await Promise.all(codes.map(async (code) => {
    try {
      const hit = await cache.match(cacheKey(code))
      if (hit) return { code, v: await hit.json() }
    } catch { /* 缓存不可读则现拉 */ }
    return { code, v: null }
  }))
  for (const { code, v } of hits) {
    if (v) {
      if (v.topic) out.set(code, v)
    } else {
      miss.push(code)
    }
  }

  let budget = LIVE_BUDGET
  await Promise.all(miss.map(async (code) => {
    if (budget <= 0) return
    budget--
    let res
    try {
      res = await fetch(BASE + '/req/getStockSearch/' + code, {
        headers: { Authorization: 'Bearer ' + token, Accept: '*/*', Referer: 'https://duanxianxia.com/' },
        signal: AbortSignal.timeout(6000),
      })
    } catch { return }
    if (res.status === 403 || res.status === 401) {
      console.log('[dxx] getStockSearch', res.status, res.status === 401 ? 'token 失效需更新 DXX_TOKEN' : '当日免费额度用完')
      budget = 0
      return
    }
    if (!res.ok) return
    let topic = null, asOf = null
    try {
      const j = await res.json()
      let best = null
      for (const it of Array.isArray(j.yidong) ? j.yidong : []) {
        if (it && it.expound && (!best || String(it.date) > String(best.date))) best = it
      }
      if (best) {
        topic = String(best.expound).split('|')[0].trim() || null
        asOf = best.date || null
      }
    } catch { return }
    if (topic) out.set(code, { topic, date: asOf })
    try {
      await cache.put(cacheKey(code), new Response(JSON.stringify({ topic, date: asOf }), {
        headers: { 'Cache-Control': 'max-age=' + (topic ? 21600 : 3600) },
      }))
    } catch { /* 缓存写失败不影响本次结果 */ }
  }))
  return out
}