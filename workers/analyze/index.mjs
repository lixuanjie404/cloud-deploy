/**
 * AI 催化分析主处理器（Cloudflare Workers）
 * POST /api/analyze  {event}  → 多阶推演 + 标的明细（不推送）
 *
 * 流程：东财概念板块 → 事件分类 → LLM 推演 → 板块名匹配 → 成分股+资金确认 → 卡片渲染
 * 分析完成后异步补拉标的日K并入库（ctx.waitUntil，不阻塞响应）。
 * 凭证走 env（LLM_API_KEY 等），推送另见 push.js。
 *
 * runPipeline 是纯分析流水线，同步接口与异步任务队列（queue.mjs）共用。
 */
import { fetchConceptBoards, stockSecid } from '../fetch/eastmoney.js'
import { classifyEvent, buildMessages, withToolGuidance, buildCarrierMessages, FALLBACK_BOARDS } from './templates.mjs'
import { reasonEvent, chatWithTools } from './llm.mjs'
import { matchBoard, mapAndConfirm, marketData } from './mapping.mjs'
import { renderCard } from './card.mjs'
import { eventKey, readAnalysisCache, writeAnalysisCache } from './cache.mjs'
import { resolveMentionedStocks } from './resolve.mjs'
import { TOOLS, prefetchSentiment, activeTools } from './tools.mjs'
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

/**
 * 轮 B（载体共振）专用快速通道：辅助分析无需推理模型，优先走 flash 通道，
 * 失败再按 env 链降级（含 glm-5.3），保证结果可用性。
 */
function fastProviders(env) {
  const out = []
  if (env.LLM_API_KEY) {
    out.push({ base: 'https://open.bigmodel.cn/api/paas/v4', key: env.LLM_API_KEY, models: ['glm-4-flash-250414'] })
  }
  if (env.OPENROUTER_API_KEY) {
    out.push({ base: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY, models: ['deepseek/deepseek-chat'] })
  }
  return out
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

/**
 * 多阶分析流水线。同步接口与异步队列共用；onCheck 为可选的取消检查回调（异步），
 * 在阶段边界调用，抛出即中止。LLM 请求本身不可中断，故不逐 token 检查。
 */
export async function runPipeline(event, env, providers, onCheck, onEvent) {
  const t0 = Date.now()
  const emit = (type, payload) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(type, payload) } catch { /* 观测失败不阻断主流程 */ }
  }
  const mark = (label, stepKey) => {
    const ms = Date.now() - t0
    console.log('[timing] ' + label + ' +' + ms + 'ms')
    if (stepKey) emit('step', { key: stepKey, label, status: 'done', ms })
  }
  const step = (stepKey, label) => emit('step', { key: stepKey, label, status: 'running' })
  const check = async () => { if (typeof onCheck === 'function') await onCheck() }
  const key = eventKey(event)

  // 1. 板块列表 + 市场基础数据（并行）
  step('boards', '读取板块与市场数据')
  let [boards, market] = await Promise.all([
    fetchConceptBoards(),
    marketData(todayStr().replace(/-/g, '')),
  ])
  mark('boards+market', 'boards')
  // 东财板块列表拉不到时用内置题材兜底（本机 fetch 偶发慢/失败，生产环境一般正常）
  if (!boards || !boards.length) boards = FALLBACK_BOARDS
  const boardNames = boards.map((b) => b.name)

  // 2. 分类 + 预取情绪包（预取失败不影响主流程）+ 构造 prompt
  step('prefetch', '准备情绪数据')
  const classified = classifyEvent(event.title || event.content)
  const sentimentPack = await prefetchSentiment(env, { date: todayStr().replace(/-/g, '') })
  mark('prefetch', 'prefetch')
  // 来源角标图例：预取包 + 每次工具调用（ref → 展示文案），供前端把 [H]/[T]/[P]/[W#] 渲染成可悬浮标注
  const sourceLegend = new Map()
  for (const s of (sentimentPack && sentimentPack.legend) || []) sourceLegend.set(s.ref, s.label)
  const collectLegend = (out) => {
    if (!out || typeof out !== 'object') return
    if (out.ref && out.label) sourceLegend.set(out.ref, out.label)
    if (Array.isArray(out.items)) {
      for (const it of out.items) {
        if (it && it.ref && (it.source || it.label)) {
          sourceLegend.set(it.ref, (it.source || it.label) + (it.date ? ' ' + it.date : '') + (it.title ? ' ' + String(it.title).slice(0, 40) : ''))
        }
      }
    }
  }
  const onTool = (name, out) => {
    collectLegend(out)
    emit('tool', { name, at: Date.now() - t0 })
  }
  const tools = activeTools(env)
  const maxRounds = Math.min(8, Math.max(1, Number(env.TOOLS_MAX_ROUNDS) || 5))
  const messages = withToolGuidance(
    buildMessages(event, boardNames, classified, sentimentPack),
    maxRounds,
    tools.map((t) => t.function.name),
  )

  await check()
  // 3. LLM 推演（带联网情绪工具；通道不支持 tools 时自动降级纯推演）
  // 预取包已含人气榜/题材热度，首轮不强制调工具：避免 glm-5.3 多跑一轮（约 40-60s）
  step('llmA', '多阶推演（轮 A）')
  const result = await reasonEvent(messages, env, { tools, maxRounds, onTool, onEvent, providers, forceFirstTool: false })
  mark('LLM-A(推演)', 'llmA')
  await check()

  // 3.5 提及个股确定性还原（suggest 校验名称/代码，多候选消歧）
  step('resolve', '还原提及标的')
  const mentionedStocks = await resolveMentionedStocks(result.mentionedStocks, event, env)
  mark('resolve(个股还原)', 'resolve')

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
  step('mapping', '匹配题材与标的')
  const candidates = await mapAndConfirm(boardSet, market.ztMap, market.flowMap)
  mark('mapAndConfirm(标的映射)', 'mapping')
  await check()

  // 4.5 轮 B：情绪载体 × 网络热门话题共振（独立降级，失败给空数组不阻塞卡片）
  step('llmB', '载体共振分析（轮 B）')
  let carrierAnalysis = []
  try {
    const carrierMsgs = buildCarrierMessages({ layers: result.layers, candidates, sentiment: result.sentiment })
    const carrier = await chatWithTools(carrierMsgs, env, {
      tools,
      maxRounds: 2,
      isValid: (p) => Array.isArray(p.carrierAnalysis),
      onTool,
      onEvent,
      providers: providers && providers.length ? providers : fastProviders(env),
      forceFirstTool: false,
    })
    carrierAnalysis = carrier.parsed.carrierAnalysis.slice(0, 8)
  } catch (err) {
    console.log('[analyze] 载体共振失败，跳过:', String(err.message || err).slice(0, 120))
  }
  mark('LLM-B(载体共振)', 'llmB')

  const legendArr = Array.from(sourceLegend.entries()).map(([ref, label]) => ({ ref, label }))
  const data = {
    type: classified.type,
    event: result.event || {},
    mentionedStocks,
    layers: result.layers || [],
    falsifier: result.falsifier || '',
    confidence: result.confidence,
    sentiment: result.sentiment || null,
    carrierAnalysis,
    sourceLegend: legendArr,
    candidates,
    model: result._model || '',
    card: renderCard({ event, result, candidates, carrierAnalysis, sourceLegend: legendArr, date: todayStr() }),
  }
  step('cache', '写入分析结果')
  await writeAnalysisCache(env, key, data)
  mark('writeCache', 'cache')
  return data
}

export async function handleAnalyze(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: '仅支持 POST' }, 405)
  }

  let event, refresh, providers
  try {
    const body = await request.json()
    event = body && body.event
    refresh = !!(body && (body.refresh === true || body.force === true))
    // 浏览器手动配置的模型优先级（localStorage，随请求下发；服务端链自动兑底）
    providers = body && Array.isArray(body.providers) ? body.providers.slice(0, 6) : null
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
    const data = await runPipeline(event, env, providers)
    const codes = collectCodes(data.candidates, data.mentionedStocks)
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
