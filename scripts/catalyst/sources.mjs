import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DWS_ENTRY, GROUP_NAME, xinhuaSettings } from './config.mjs'

const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 钉钉群（dws CLI） ----------

export async function fetchDingTalk({ days = 1, maxItems = 200 } = {}) {
  const start = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10)
  const args = [
    DWS_ENTRY, 'chat', '+chat-messages',
    '--group', GROUP_NAME,
    '--start', start,
    '--order', 'asc',
    '--page-all',
    '--page-limit', '20',
    '--max-items', String(maxItems),
    '--format', 'json',
  ]
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 12 * 1024 * 1024,
      timeout: 180000,
      windowsHide: true,
    })
    const data = JSON.parse(stdout)
    const messages = Array.isArray(data.messages) ? data.messages : []
    return messages.map((m, i) => ({
      id: m.messageId || m.id || `dt-${i}`,
      source: '钉钉群',
      title: String(m.subject || m.title || '').trim(),
      content: String(m.content || m.text || m.contentSnippet || '').trim(),
      time: m.createAt || m.createdAt || m.time || '',
      sender: m.senderName || m.sender || '',
      url: '',
    })).filter((e) => e.content)
  } catch (err) {
    console.error(`[sources] 钉钉群读取失败: ${String(err.message || err).slice(0, 200)}`)
    return []
  }
}

// ---------- 新华财经 MCP ----------

function looseParse(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function payloadFromRpc(rpc) {
  const content = rpc?.result?.content
  if (!Array.isArray(content) || !content.length) return null
  let text = content[0]?.text
  if (!text) return null
  text = looseParse(text)
  if (typeof text !== 'object' || text === null) return null
  const env = text
  if (env.success === false || env.success === 'false') {
    throw new Error(`MCP 业务错误: ${env.errorInfo || env.errorCode}`)
  }
  return looseParse(env.data)
}

async function mcpCall(name, args, settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${settings.key}`,
  }
  const post = async (body) => {
    const res = await fetch(settings.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeout),
    })
    if (res.status === 401 || res.status === 403) throw new Error(`新华财经 Key 无效 (${res.status})`)
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
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
        params: {
          protocolVersion: settings.protocol,
          capabilities: {},
          clientInfo: { name: 'catalyst-mvp', version: '1.0' },
        },
      })
      const rpc = await post({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: args || {} },
      })
      if (rpc.error) throw new Error(`MCP error: ${JSON.stringify(rpc.error).slice(0, 150)}`)
      return payloadFromRpc(rpc)
    } catch (err) {
      lastErr = String(err.message || err)
      if (attempt < 2) await sleep(1000 * (attempt + 1))
    }
  }
  throw new Error(`新华财经调用失败（已重试）: ${lastErr}`)
}

const fmt = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export async function fetchXinhua({ days = 3, limit = 30 } = {}) {
  try {
    const settings = xinhuaSettings()
    const end = fmt(new Date())
    const beg = fmt(new Date(Date.now() - Math.max(1, days) * 86400000))
    const data = await mcpCall('get_xhcj_hotNews', { begTime: beg, endTime: end }, settings)
    const rows = Array.isArray(data) ? data : (data?.data || [])
    return rows.slice(0, limit).map((r, i) => ({
      id: String(r.id || r.ID || `xh-${i}`),
      source: '新华财经',
      title: String(r.Title || r.title || '').trim(),
      content: String(r.contentTxt || r.content || '').trim(),
      time: String(r.publishTime || r.publish_time || ''),
      sender: String(r.source || '新华财经'),
      url: String(r.sourceUrl || r.url || ''),
    })).filter((e) => e.title || e.content)
  } catch (err) {
    console.error(`[sources] 新华财经读取失败: ${String(err.message || err).slice(0, 200)}`)
    return []
  }
}

// ---------- 合并去重 ----------

export async function collectEvents({ days = 1, limit = 30, sources = 'both' } = {}) {
  const tasks = []
  if (sources === 'both' || sources === 'dingtalk') tasks.push(fetchDingTalk({ days }))
  if (sources === 'both' || sources === 'xinhua') tasks.push(fetchXinhua({ days, limit }))
  const groups = await Promise.all(tasks)
  const seen = new Set()
  const out = []
  for (const event of groups.flat()) {
    const key = (event.title || event.content).replace(/[\s，。！？、]/g, '').slice(0, 60)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(event)
  }
  return out.slice(0, limit)
}
