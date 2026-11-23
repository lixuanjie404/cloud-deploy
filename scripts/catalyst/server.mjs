/**
 * catalyst 本地 API 服务
 *
 * 为什么不放进 Worker：分析依赖本地 config.json 的智谱/新华财经密钥、
 * dws CLI（钉钉），以及东财公网接口。Worker 运行时拿不到本地密钥和 CLI，
 * 所以单独起一个 Express 服务桥接，前端页面通过 CORS 调用。
 *
 * 启动：npm run catalyst:server  （默认 8788，可用 CATALYST_PORT 覆盖）
 * 接口：
 *   GET  /api/events?days=3&limit=20       近期事件源（钉钉+新华财经）
 *   POST /api/analyze  {event}             多阶分析 + 标的明细（不推送）
 *   POST /api/push     {event,result}      推送钉钉 + 记反馈
 *   GET  /api/health                        健康检查
 */
import express from 'express'
import { collectEvents } from './sources.mjs'
import { classifyEvent, buildMessages } from './templates.mjs'
import { reasonEvent } from './llm.mjs'
import { fetchConceptBoards, matchBoard, fetchZTPool, fetchMainFlow, mapAndConfirm } from './mapping.mjs'
import { renderCard } from './card.mjs'
import { pushToGroup } from './push.mjs'
import { appendFeedback, readFeedback } from './feedback.mjs'

const PORT = Number(process.env.CATALYST_PORT || 8788)
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// 轻量缓存：事件列表 5 分钟，市场基础数据 5 分钟，分析结果当天按事件 key 复用
const cache = { events: null, market: null, analysis: new Map() }
const TTL = { events: 5 * 60 * 1000, market: 5 * 60 * 1000 }
const keyOf = (e) => String(e.id || e.title || e.content || '').slice(0, 80)

async function marketData () {
  if (cache.market && Date.now() - cache.market.ts < TTL.market) return cache.market.data
  const boards = await fetchConceptBoards()
  let ztMap = new Map(); let flowMap = new Map()
  try { ztMap = await fetchZTPool(new Date().toISOString().slice(0, 10)) } catch { /* 降级为空 */ }
  try { flowMap = await fetchMainFlow() } catch { /* 降级为空 */ }
  const data = { boards, boardNames: boards.map((b) => b.name), ztMap, flowMap }
  cache.market = { ts: Date.now(), data }
  return data
}

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

app.get('/api/events', async (req, res) => {
  try {
    const days = Math.min(7, Math.max(1, Number(req.query.days) || 3))
    const limit = Math.min(40, Math.max(1, Number(req.query.limit) || 20))
    if (cache.events && Date.now() - cache.events.ts < TTL.events && cache.events.days === days) {
      return res.json({ ok: true, cached: true, events: cache.events.data })
    }
    const events = await collectEvents({ days, limit, sources: 'both' })
    cache.events = { ts: Date.now(), days, data: events }
    res.json({ ok: true, cached: false, events })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) })
  }
})

app.post('/api/analyze', async (req, res) => {
  try {
    const event = req.body && req.body.event
    if (!event || !(event.title || event.content)) {
      return res.status(400).json({ ok: false, error: '缺少 event.title / event.content' })
    }
    const key = keyOf(event)
    const hit = cache.analysis.get(key)
    if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) {
      return res.json({ ok: true, cached: true, ...hit.data })
    }
    const classified = classifyEvent(event.title || event.content)
    const { boardNames, boards, ztMap, flowMap } = await marketData()
    const messages = buildMessages(event, boardNames, classified)
    const result = await reasonEvent(messages)
    const boardSet = []
    for (const layer of result.layers || []) {
      const names = layer.level === 3
        ? (layer.boards || [])
        : (layer.targets || []).map((t) => t.board)
      for (const name of names || []) {
        const board = matchBoard(name, boards)
        if (board && !boardSet.some((b) => b.code === board.code)) boardSet.push(board)
      }
    }
    const candidates = await mapAndConfirm(boardSet, ztMap, flowMap)
    const card = renderCard({ event, result, candidates, date: new Date().toISOString().slice(0, 10) })
    const data = {
      type: classified.type,
      event: result.event || {},
      layers: result.layers || [],
      falsifier: result.falsifier || '',
      confidence: result.confidence,
      candidates,
      card,
      model: result._model || '',
    }
    cache.analysis.set(key, { ts: Date.now(), data })
    res.json({ ok: true, cached: false, ...data })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 400), raw: err.raw ? String(err.raw).slice(0, 600) : undefined })
  }
})

app.post('/api/push', async (req, res) => {
  try {
    const { event, result, card } = req.body || {}
    const content = card || (result && result.card)
    if (!content) return res.status(400).json({ ok: false, error: '缺少 card 内容' })
    const sent = await pushToGroup(content, { send: true })
    let feedbackFile = ''
    if (event && result) {
      feedbackFile = appendFeedback({
        event: { id: event.id, source: event.source, title: event.title, url: event.url, time: event.time },
        type: result.type || '',
        result: { event: result.event, layers: result.layers, falsifier: result.falsifier, confidence: result.confidence },
        candidates: result.candidates || [],
      })
    }
    res.json({ ok: sent.ok, output: sent.output || '', error: sent.error || '', feedbackFile })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) })
  }
})

app.get('/api/feedback', (req, res) => res.json({ ok: true, records: readFeedback() }))

app.listen(PORT, () => {
  console.log(`[catalyst] API 服务已启动: http://127.0.0.1:${PORT}`)
  console.log(`[catalyst] 接口: /api/events  /api/analyze  /api/push  /api/health`)
})
