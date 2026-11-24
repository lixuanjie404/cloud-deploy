/**
 * AI 催化分析主处理器（Cloudflare Workers）
 * POST /api/analyze  {event}  → 多阶推演 + 标的明细（不推送）
 *
 * 流程：东财概念板块 → 事件分类 → LLM 推演 → 板块名匹配 → 成分股+资金确认 → 卡片渲染
 * 分析完成后异步补拉标的日K并入库（ctx.waitUntil，不阻塞响应）。
 * 凭证走 env（LLM_API_KEY 等），推送另见 push.js。
 */
import { fetchConceptBoards, stockSecid } from '../fetch/eastmoney.js'
import { classifyEvent, buildMessages, FALLBACK_BOARDS } from './templates.mjs'
import { reasonEvent } from './llm.mjs'
import { matchBoard, mapAndConfirm, marketData } from './mapping.mjs'
import { renderCard } from './card.mjs'
import { eventKey, readAnalysisCache, writeAnalysisCache } from './cache.mjs'
import { resolveMentionedStocks } from './resolve.mjs'
import { pullOne } from '../cron.js'

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

function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 从标的明细 + LLM 原文提及中提取去重的 6 位代码 */
function collectCodes(candidates, mentioned) {
  const seen = new Set()
  for (const s of [...(candidates || []), ...(mentioned || [])]) {
    const code = String((s && s.code) || '').trim()
    if (/^\d{6}$/.test(code)) seen.add(code)
  }
  return [...seen]
}

/** 异步补拉日K并落表（复用 cron 的 pullOne，失败仅记日志） */
async function backfillDaily(env, codes) {
  const tail = Math.max(60, Number(env.UPSERT_TAIL) || 120)
  let ok = 0
  for (const code of codes) {
    const r = await pullOne(env, code, 'raw', stockSecid(code), tail)
    if (r.ok) ok++
  }
  console.log('[analyze] 日K补拉完成', ok + '/' + codes.length)
}

export async function handleAnalyze(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: '仅支持 POST' }, 405)
  }

  let event, refresh
  try {
    const body = await request.json()
    event = body && body.event
    refresh = !!(body && (body.refresh === true || body.force === true))
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400)
  }
  if (!event || !(event.title || event.content)) {
    return json({ ok: false, error: '缺少 event.title / event.content' }, 400)
  }

  try {
    const key = eventKey(event)
    if (!refresh) {
      const hit = await readAnalysisCache(env, key)
      if (hit) return json({ ok: true, ...hit.payload, cached: true, cachedAt: hit.cachedAt })
    }

    // 1. 板块列表 + 市场基础数据（并行）
    let [boards, market] = await Promise.all([
      fetchConceptBoards(),
      marketData(todayStr().replace(/-/g, '')),
    ])
    // 东财板块列表拉不到时用内置题材兜底（本机 fetch 偶发慢/失败，生产环境一般正常）
    if (!boards || !boards.length) boards = FALLBACK_BOARDS
    const boardNames = boards.map((b) => b.name)

    // 2. 分类 + 构造 prompt
    const classified = classifyEvent(event.title || event.content)
    const messages = buildMessages(event, boardNames, classified)

    // 3. LLM 推演
    const result = await reasonEvent(messages, env)

    // 3.5 提及个股确定性还原（suggest 校验名称/代码，多候选消歧）
    const mentionedStocks = await resolveMentionedStocks(result.mentionedStocks, event, env)

    // 4. 板块名匹配 → 标的映射
    const boardSet = []
    for (const layer of result.layers || []) {
      const names = Number(layer.level) === 3
        ? (layer.boards || [])
        : (layer.targets || []).map((t) => t.board)
      for (const name of names || []) {
        const board = matchBoard(name, boards)
        if (board && !boardSet.some((b) => b.code === board.code)) boardSet.push(board)
      }
    }
    const candidates = await mapAndConfirm(boardSet, market.ztMap, market.flowMap)

    const data = {
      type: classified.type,
      event: result.event || {},
      mentionedStocks,
      layers: result.layers || [],
      falsifier: result.falsifier || '',
      confidence: result.confidence,
      candidates,
      model: result._model || '',
      card: renderCard({ event, result, candidates, date: todayStr() }),
    }
    await writeAnalysisCache(env, key, data)

    const codes = collectCodes(candidates, result.mentionedStocks)
    if (codes.length) {
      console.log('[analyze] 异步补拉日K', codes.join(','))
      const task = backfillDaily(env, codes)
      if (ctx && ctx.waitUntil) ctx.waitUntil(task)
    }
    return json({ ok: true, ...data, cached: false })
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 400) }, 500)
  }
}
