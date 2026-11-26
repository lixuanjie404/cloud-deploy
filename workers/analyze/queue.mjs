/**
 * 催化推演 · 异步任务队列
 *
 * POST /api/analyze/tasks      提交任务（立即返回 taskId，后台 ctx.waitUntil 执行）
 * GET  /api/analyze/tasks      任务列表（?status=running&limit=50）
 * GET  /api/analyze/tasks/:id  单个任务（含结果）
 *
 * 规则：
 * - 不同消息（eventKey）的任务互不取消，各自排队执行；
 * - 同一消息新任务提交时，旧的 queued/running 任务置 cancelled；
 * - 浏览器下发的 providers 含密钥，不落库；任务执行走服务端默认通道链。
 */
import { eventKey } from './cache.mjs'
import { runPipeline } from './index.mjs'
import { insertTask, cancelByEvent, claimTask, setTaskStatus, setTaskProgress, getTask, listTasks } from './taskstore.mjs'

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

// 并发时 glm-5.3 单次调用可达 80s 且可能连跑 4 轮，留足余量（单次 LLM_TIMEOUT 为 300s）
const TASK_TIMEOUT_MS = 360000

/** 执行单个任务：抢占 → 流水线（阶段边界检查取消）→ 写结果/失败 */
export async function runTask(id, env) {
  let task
  try {
    task = await getTask(env, id)
  } catch (err) {
    console.warn('[task] 读取任务失败 ' + id + ': ' + String(err.message || err).slice(0, 160))
    return
  }
  if (!task || task.status !== 'queued') return

  try {
    const claimed = await claimTask(env, id)
    if (!claimed) return
  } catch (err) {
    console.warn('[task] 抢占失败 ' + id + ': ' + String(err.message || err).slice(0, 160))
    return
  }

  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('任务执行超时（' + Math.round(TASK_TIMEOUT_MS / 1000) + 's）')), TASK_TIMEOUT_MS)
  })
  const checkCancelled = async () => {
    const t = await getTask(env, id)
    if (!t || t.status !== 'running') throw new Error('任务已取消')
  }

  // 进度快照：步骤 / 思考全文 / 工具调用；写库节流避免逐 token 写
  const progress = { steps: [], thinking: '', tools: [], updatedAt: Date.now() }
  let flushTimer = null
  let writing = false
  const persist = async () => {
    if (writing) return
    writing = true
    progress.updatedAt = Date.now()
    try { await setTaskProgress(env, id, progress) }
    catch (err) { console.warn('[task] 进度写入失败:', String(err.message || err).slice(0, 120)) }
    finally { writing = false }
  }
  const schedulePersist = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => { flushTimer = null; persist() }, 800)
  }
  const onEvent = (type, payload) => {
    if (type === 'step') {
      const i = progress.steps.findIndex((s) => s.key === payload.key)
      if (i >= 0) progress.steps[i] = { ...payload }
      else progress.steps.push({ ...payload })
      persist()
    } else if (type === 'thinking') {
      // 按增量追加：多轮/重试各自独立累加 reasoning_text，用 text 覆盖会丢失前序轮次
      progress.thinking += String(payload.delta || '')
      schedulePersist()
    } else if (type === 'tool') {
      progress.tools.push({ name: payload.name, at: payload.at })
      if (progress.tools.length > 30) progress.tools.shift()
      schedulePersist()
    }
  }

  try {
    const result = await Promise.race([
      runPipeline(task.request.event, env, null, checkCancelled, onEvent),
      timeout,
    ])
    await setTaskStatus(env, id, 'done', { result, progress })
    console.log('[task] 完成', id)
  } catch (err) {
    let finalStatus = 'failed'
    try {
      const t = await getTask(env, id)
      if (t && t.status === 'cancelled') finalStatus = 'cancelled'
    } catch { /* 保留 failed */ }
    try {
      await setTaskStatus(env, id, finalStatus, { error: String(err.message || err).slice(0, 500), progress })
    } catch (e) {
      console.warn('[task] 写失败状态出错 ' + id + ': ' + String(e.message || e).slice(0, 160))
    }
    console.log('[task] ' + finalStatus, id, String(err.message || err).slice(0, 160))
  } finally {
    if (timer) clearTimeout(timer)
    if (flushTimer) clearTimeout(flushTimer)
  }
}

/** 提交任务：同消息旧任务取消，新任务入队后立即返回 */
export async function handleSubmitTask(request, env, ctx) {
  if (request.method !== 'POST') return json({ ok: false, error: '仅支持 POST' }, 405)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400)
  }
  const event = body && body.event
  if (!event || !(event.title || event.content)) {
    return json({ ok: false, error: '缺少 event.title / event.content' }, 400)
  }

  const key = eventKey(event)
  const id = crypto.randomUUID()
  // providers 含浏览器密钥，按前端承诺不落库；只保存事件与 refresh
  const snapshot = { event, refresh: !!(body && (body.refresh || body.force)) }

  try {
    await cancelByEvent(env, key)
    await insertTask(env, {
      id,
      eventKey: key,
      title: String(event.title || event.content || '').slice(0, 255),
      request: snapshot,
    })
  } catch (err) {
    return json({ ok: false, error: '任务入库失败: ' + String(err.message || err).slice(0, 200) }, 500)
  }

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(runTask(id, env))
  } else {
    // 本地脚本 / 测试环境无 ctx：不阻塞响应，但继续后台执行
    runTask(id, env).catch((err) => console.warn('[task] 后台执行出错: ' + String(err.message || err)))
  }
  return json({ ok: true, taskId: id, status: 'queued' })
}

/** 任务列表：?status=queued|running|done|failed|cancelled&limit=N */
export async function handleListTasks(request, env, url) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)
  try {
    const tasks = await listTasks(env, url.searchParams.get('status'), url.searchParams.get('limit'))
    return json({ ok: true, tasks })
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 300) }, 500)
  }
}

/** 单个任务详情（含 request / result） */
export async function handleGetTask(request, env, id) {
  if (request.method !== 'GET') return json({ ok: false, error: '仅支持 GET' }, 405)
  try {
    const task = await getTask(env, id)
    if (!task) return json({ ok: false, error: '任务不存在' }, 404)
    return json({ ok: true, task })
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 300) }, 500)
  }
}
