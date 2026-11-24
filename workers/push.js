/**
 * 钉钉群机器人推送（Cloudflare Workers）—— 替代本机 dws CLI，实现推送上云
 *
 * POST /api/push  {event, result}  → 钉钉群机器人 Webhook 发 markdown 卡片
 *
 * 凭证走 env（wrangler var）：
 *   DINGTALK_WEBHOOK  —— https://oapi.dingtalk.com/robot/send?access_token=XXXX
 *   DINGTALK_SECRET   —— SEC 开头的加签密钥（若用加签模式）
 *   DINGTALK_KEYWORD  —— 自定义关键词（若用关键词模式，正文会带上它）
 * 安全设置二选一（加签优先）。限流 20 条/分钟，本模块单次单条推送。
 */
import { renderCard } from './analyze/card.mjs'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/** HMAC-SHA256 加签（Web Crypto API，Workers 原生支持） */
async function sign(secret, timestamp) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + '\n' + secret))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return encodeURIComponent(b64)
}

/** 把纯文本卡片转成钉钉 markdown（钉钉 markdown 支持有限，做基础转换） */
function cardToMarkdown(card, keyword) {
  const lines = String(card || '').split('\n')
  const out = []
  for (const line of lines) {
    if (line.startsWith('【')) out.push('### ' + line.replace(/^【|】$/g, ''))
    else if (line.startsWith('推演链：') || line.startsWith('候选标的')) out.push('\n**' + line + '**\n')
    else if (line.startsWith('  ')) out.push('- ' + line.trim().replace(/^- /, ''))
    else if (line.startsWith('>')) out.push('\n> ' + line.replace(/^> /, ''))
    else if (line.trim()) out.push(line)
  }
  let text = out.join('\n')
  if (keyword && !text.includes(keyword)) text = keyword + '\n' + text
  return text
}

export async function handlePush(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: '仅支持 POST' }, 405)

  const webhook = env.DINGTALK_WEBHOOK
  if (!webhook) return json({ ok: false, error: '未配置 DINGTALK_WEBHOOK（wrangler var）' }, 503)

  let payload
  try {
    payload = await request.json()
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400)
  }

  const event = payload.event || {}
  const result = payload.result || {}
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const card = result.card || renderCard({ event, result, candidates: result.candidates || [], date: today })
  const text = cardToMarkdown(card, env.DINGTALK_KEYWORD)

  let url = webhook
  try {
    if (env.DINGTALK_SECRET) {
      const ts = String(Date.now())
      const signParam = await sign(env.DINGTALK_SECRET, ts)
      url += (url.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + signParam
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '催化推演', text },
      }),
    })
    const data = await res.json()
    if (data.errcode !== 0) {
      return json({ ok: false, error: '钉钉返回 ' + data.errcode + ': ' + data.errmsg }, 502)
    }
    return json({ ok: true, errcode: 0 })
  } catch (err) {
    return json({ ok: false, error: '推送失败：' + String(err.message || err).slice(0, 300) }, 502)
  }
}
