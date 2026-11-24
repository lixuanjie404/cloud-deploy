/**
 * 新华财经 MCP 直连（Cloudflare Workers）—— 纯 HTTP，上云无本机依赖
 * 凭证走 env.XINHUA_KEY
 */
const URL_MCP = 'https://mcp.cnfic.com.cn/mcp-servers/xhcj-mcp-announcements-news-policy'
const PROTOCOL = '2025-03-26'

function looseParse(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function payloadFromRpc(rpc) {
  const content = rpc && rpc.result && rpc.result.content
  if (!Array.isArray(content) || !content.length) return null
  let text = content[0] && content[0].text
  if (!text) return null
  text = looseParse(text)
  if (!text || typeof text !== 'object') return null
  if (text.success === false || text.success === 'false') {
    throw new Error('MCP 业务错误：' + (text.errorInfo || text.errorCode))
  }
  return looseParse(text.data)
}

async function mcpCall(name, args, key) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + key,
  }
  const post = async (body) => {
    const res = await fetch(URL_MCP, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    if (res.status === 401 || res.status === 403) throw new Error('新华财经 Key 无效 (' + res.status + ')')
    if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status)
    const raw = await res.text()
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/event-stream')) {
      const line = raw.split('\n').find((l) => l.startsWith('data:'))
      if (!line) throw new Error('SSE 无 data 载荷')
      return JSON.parse(line.slice(5).trim())
    }
    return JSON.parse(raw)
  }
  let lastErr = ''
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      await post({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cloud-deploy-catalyst', version: '1.0' } },
      })
      const rpc = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } })
      if (rpc.error) throw new Error('MCP error: ' + JSON.stringify(rpc.error).slice(0, 150))
      return payloadFromRpc(rpc)
    } catch (err) {
      lastErr = String(err.message || err)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw new Error('新华财经调用失败（已重试）：' + lastErr)
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

export async function fetchXinhua(env, { days = 3, limit = 30 } = {}) {
  const key = env.XINHUA_KEY
  if (!key) return []
  try {
    const end = fmt(new Date())
    const beg = fmt(new Date(Date.now() - Math.max(1, days) * 86400000))
    const data = await mcpCall('get_xhcj_hotNews', { begTime: beg, endTime: end }, key)
    const rows = Array.isArray(data) ? data : (data && data.data || [])
    return rows.slice(0, limit).map((r, i) => ({
      id: String(r.id || r.ID || 'xh-' + i),
      source: '新华财经',
      title: String(r.Title || r.title || '').trim(),
      content: String(r.contentTxt || r.content || '').trim(),
      time: String(r.publishTime || r.publish_time || ''),
      sender: String(r.source || '新华财经'),
      url: String(r.sourceUrl || r.url || ''),
    })).filter((e) => e.title || e.content)
  } catch (err) {
    console.log('[xinhua] 读取失败：' + String(err.message || err).slice(0, 200))
    return []
  }
}
