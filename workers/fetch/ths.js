/**
 * 同花顺涨停池封装（Cloudflare Workers）
 *
 * 涨停池自带 reason_type（涨停原因/异动解析），格式为「+」连接的多个炒作题材，
 * 如「厨房小家电+机器人投资+“羊”字辈」。炸板池该字段恒为 null，故只拉涨停池。
 * 非涨停标的（热门/强势通道）无解析，由调用方回退东财行业。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const HEADERS = { 'User-Agent': UA, Referer: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html' }

/**
 * 按日期拉涨停原因解析
 * @param {string} date YYYYMMDD
 * @returns {Promise<Map<string, string>>} code → reason_type 原文；休市/失败返回空 Map
 */
export async function fetchLimitUpReasons(date) {
  const reasons = new Map()
  const pageSize = 100
  for (let page = 1; page <= 4; page++) {
    const target =
      'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool' +
      '?page=' + page + '&limit=' + pageSize +
      '&field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004' +
      '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + encodeURIComponent(date)
    let info, total
    try {
      const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(6000) })
      if (!res.ok) break
      const payload = await res.json()
      if (!payload || payload.status_code !== 0 || !payload.data) break
      info = payload.data.info || []
      total = (payload.data.page && payload.data.page.total) || 0
    } catch {
      break
    }
    for (const it of info) {
      if (it && it.code && it.reason_type) reasons.set(String(it.code), String(it.reason_type))
    }
    if (page * pageSize >= total || !info.length) break
  }
  return reasons
}