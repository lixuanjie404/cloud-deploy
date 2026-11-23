import { collectEvents } from './sources.mjs'
import { classifyEvent, buildMessages } from './templates.mjs'
import { reasonEvent } from './llm.mjs'
import { fetchConceptBoards, matchBoard, fetchZTPool, fetchMainFlow, mapAndConfirm } from './mapping.mjs'
import { renderCard } from './card.mjs'
import { pushToGroup } from './push.mjs'
import { appendFeedback } from './feedback.mjs'

function parseArgs(argv) {
  const args = { source: 'both', limit: 3, days: 1, send: false, event: '' }
  for (const a of argv) {
    if (a.startsWith('--source=')) args.source = a.split('=')[1]
    else if (a.startsWith('--limit=')) args.limit = Number(a.split('=')[1]) || 3
    else if (a.startsWith('--days=')) args.days = Number(a.split('=')[1]) || 1
    else if (a.startsWith('--event=')) args.event = a.slice(8)
    else if (a === '--send') args.send = true
  }
  return args
}

const EMPTY_MAP = new Map()

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const date = new Date().toISOString().slice(0, 10)

  let events
  if (args.event) {
    events = [{ id: 'manual', source: '手动输入', title: args.event, content: args.event, time: date, url: '' }]
  } else {
    events = await collectEvents({ days: args.days, limit: args.limit, sources: args.source })
  }
  if (!events.length) {
    console.log('没有拉到消息。可加 --source=xinhua/dingtalk 或 --event="..." 手动测试。')
    return
  }
  console.log(`[run] 消息 ${events.length} 条，来源=${args.event ? '手动' : args.source}`)

  let boards = []
  let ztMap = EMPTY_MAP
  let flowMap = EMPTY_MAP
  try {
    boards = await fetchConceptBoards()
    console.log(`[run] 东财概念板块 ${boards.length} 个`)
  } catch (err) {
    console.error(`[run] 概念板块拉取失败: ${String(err.message || err).slice(0, 120)}`)
  }
  try {
    ztMap = await fetchZTPool(date)
  } catch (err) {
    console.error(`[run] 涨停池拉取失败: ${String(err.message || err).slice(0, 120)}`)
  }
  try {
    flowMap = await fetchMainFlow()
  } catch (err) {
    console.error(`[run] 主力净额拉取失败: ${String(err.message || err).slice(0, 120)}`)
  }
  const boardNames = boards.map((b) => b.name)

  for (const event of events.slice(0, args.limit)) {
    const classified = classifyEvent(event.title || event.content)
    console.log(`\n========== ${event.source} · ${classified.type} ==========`)
    console.log(`消息：${(event.title || event.content).slice(0, 160)}`)
    try {
      const messages = buildMessages(event, boardNames, classified)
      const result = await reasonEvent(messages)
      const boardSet = []
      for (const layer of result.layers || []) {
        const candidates = layer.level === 3 ? layer.boards : (layer.targets || []).map((t) => t.board)
        for (const name of candidates || []) {
          const board = matchBoard(name, boards)
          if (board && !boardSet.some((b) => b.code === board.code)) boardSet.push(board)
        }
      }
      const stocks = await mapAndConfirm(boardSet, ztMap, flowMap)
      const card = renderCard({ event, result, candidates: stocks, date })
      console.log('\n' + card)

      const push = await pushToGroup(card, { send: args.send })
      console.log(`\n[push] ${args.send ? '已发送' : 'dry-run 预览'}: ${push.ok ? push.output : push.error}`)
      if (args.send) {
        const file = appendFeedback({
          event: { id: event.id, source: event.source, title: event.title, url: event.url, time: event.time },
          type: classified.type,
          result: { event: result.event, layers: result.layers, falsifier: result.falsifier, confidence: result.confidence },
          candidates: stocks,
        })
        console.log(`[feedback] 已记录 ${file}`)
      }
    } catch (err) {
      console.error(`[run] 推理失败: ${String(err.message || err).slice(0, 250)}`)
      if (err.raw) console.error(`[run] LLM 原始输出：${String(err.raw).slice(0, 500)}`)
    }
  }
}

main().catch((err) => {
  console.error('[run] 致命错误:', err)
  process.exit(1)
})
