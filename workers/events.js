/**
 * 事件源只读接口（Cloudflare Workers）
 * GET /api/catalyst/events?source=dingtalk|xinhua&limit=20&days=3&offset=0&q=关键词
 *
 * - dingtalk：从 dingtalk_message 表读（本机 sync:dingtalk 脚本落库），q 用 LOCATE 下推到 SQL
 * - xinhua：Worker 实时直连新华财经 MCP（env.XINHUA_KEY），q 在返回后过滤
 *
 * 安全：仅 GET、limit 上限、Cache-Control，沿用 db.js 只读模式。
 */
import { createConnection } from 'mysql2/promise'
import { connectionOptions } from './kline.js'
import { fetchXinhua } from './fetch/xinhua.mjs'

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/** 钉钉正文首行多为模板（#### 每日调研 / > 发布人），跳过取首个实质行作标题 */
function pickDingtalkTitle(content) {
  const lines = String(content || '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line) || /^>\s?/.test(line)) continue
    if (/^[\s\-—_=·*#`]+$/.test(line) || line === '每日调研') continue
    return line.slice(0, 120)
  }
  return '钉钉群消息'
}

/** 钉钉消息从库读（按 create_time 倒序，支持分页、天数与关键词过滤） */
async function readDingtalk(env, limit, offset, days, q) {
  const opts = connectionOptions(env)
  if (!opts) return { error: '未配置数据库连接' }
  const conn = await createConnection(opts)
  try {
    // create_time 存的是北京时间字符串，用同样口径算起点（days 过滤此前解析未用，现补上）
    const since = new Date(Date.now() - days * 86400000 + 8 * 3600000)
      .toISOString().slice(0, 19).replace('T', ' ')
    const hasQuery = !!q
    // 用 LOCATE 做子串匹配，避免 LIKE 的 %/_ 通配符语义干扰；关键词直接作参数传入
    const cond = hasQuery ? ' AND (LOCATE(?, content) > 0 OR LOCATE(?, sender) > 0)' : ''
    const params = hasQuery ? [since, q, q, limit + 1, offset] : [since, limit + 1, offset]
    const [rows] = await conn.query(
      'SELECT message_id, create_time, sender, group_name, content FROM dingtalk_message ' +
      'WHERE content IS NOT NULL AND content <> \'\' AND create_time >= ?' + cond +
      ' ORDER BY create_time DESC LIMIT ? OFFSET ?',
      params,
    )
    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    const events = rows.map((r, i) => ({
      id: r.message_id || ('dt-' + i),
      source: '钉钉群',
      title: pickDingtalkTitle(r.content),
      content: String(r.content || ''),
      time: String(r.create_time || ''),
      sender: String(r.sender || ''),
      url: '',
    }))
    return { events, hasMore, nextOffset: offset + events.length }
  } finally {
    try { await conn.end() } catch { /* 忽略 */ }
  }
}

export async function handleEvents(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)

  const source = ['dingtalk', 'xinhua'].includes(url.searchParams.get('source'))
    ? url.searchParams.get('source') : 'dingtalk'
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 3))
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80)

  try {
    if (source === 'xinhua') {
      let events = await fetchXinhua(env, { days, limit })
      if (q) {
        const needle = q.toLowerCase()
        events = events.filter((e) =>
          [e.title, e.content, e.summary].some((v) => String(v || '').toLowerCase().includes(needle)))
      }
      return json({ ok: true, source, q, count: events.length, events, hasMore: false, nextOffset: 0 }, 200, 'no-store')
    }

    const result = await readDingtalk(env, limit, offset, days, q)
    if (result.error) return json({ ok: false, error: result.error }, 503)
    return json({ ok: true, source, q, count: result.events.length, events: result.events, hasMore: result.hasMore, nextOffset: result.nextOffset }, 200, 'no-store')
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 300) }, 500)
  }
}
