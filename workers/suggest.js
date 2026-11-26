/**
 * 标的检索接口（走势弹窗「输入名称首字母选标的」）
 *
 *   GET /api/suggest?q=payh    拼音首字母 / 全拼 / 中文 / 代码前缀
 *
 * 数据源：东方财富 suggest 接口（quote 页同款公开 token），type=14。
 * 只返回 Classify=AStock 且代码为 6 位数字的条目（沪深京 A 股），
 * 港股 / 美股 / 基金 / 指数一律过滤；前端拿到 6 位代码后自行按首位推断市场。
 */

const EM_SUGGEST = 'https://searchapi.eastmoney.com/api/suggest/get'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function json (body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export async function handleSuggestRequest (request, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)

  const q = (url.searchParams.get('q') || '').trim().slice(0, 16)
  if (!q) return json({ ok: true, q: '', items: [] })

  const target = EM_SUGGEST +
    '?input=' + encodeURIComponent(q) +
    '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=20'

  let payload
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      cf: { cacheTtl: 300, cacheEverything: true },
    })
    if (!res.ok) return json({ ok: false, error: `上游返回 ${res.status}` }, 502)
    payload = await res.json()
  } catch (err) {
    return json({ ok: false, error: `上游请求失败：${err.message}` }, 502)
  }

  const rows = (payload && payload.QuotationCodeTable && payload.QuotationCodeTable.Data) || []
  const items = rows
    .filter(function (r) {
      return r && r.Classify === 'AStock' && /^\d{6}$/.test(String(r.Code))
    })
    .slice(0, 8)
    .map(function (r) {
      return { code: String(r.Code), name: String(r.Name), pinyin: String(r.PinYin || '').toLowerCase() }
    })

  return json(
    { ok: true, q, items },
    200,
    'public, max-age=300, s-maxage=600',
  )
}
