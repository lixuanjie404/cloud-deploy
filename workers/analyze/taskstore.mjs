/**
 * 催化推演 · 异步任务存储（MySQL via Hyperdrive）
 *
 * 表 catalyst_analysis_task 记录每次多阶分析任务的状态与结果：
 * - event_key 复用 cache.mjs 的 eventKey；同一消息新任务提交时旧任务置 cancelled
 * - 列表查询不返回 request/result，保持轻量
 * - 连接/建表写法照搬 cache.mjs，数据库异常由调用方降级处理
 */
import { createConnection } from 'mysql2/promise'
import { connectionOptions } from '../kline.js'

const CREATE_SQL =
  'CREATE TABLE IF NOT EXISTS catalyst_analysis_task (' +
  'id VARCHAR(36) NOT NULL PRIMARY KEY,' +
  'event_key VARCHAR(96) NOT NULL,' +
  'status VARCHAR(16) NOT NULL,' +
  'title VARCHAR(255) NULL,' +
  'request LONGTEXT NOT NULL,' +
  'result LONGTEXT NULL,' +
  'progress LONGTEXT NULL,' +
  'error VARCHAR(500) NULL,' +
  'created_at DATETIME NOT NULL,' +
  'updated_at DATETIME NOT NULL,' +
  'started_at DATETIME NULL,' +
  'finished_at DATETIME NULL,' +
  'KEY ix_task_event_status (event_key, status),' +
  'KEY ix_task_created (created_at)' +
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

let tableReady = null
let lastSweep = 0

function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/** 建表只做一次；失败后清空 promise，下次请求可重试 */
function ensureTable(conn) {
  if (!tableReady) {
    tableReady = (async () => {
      await conn.query(CREATE_SQL)
      // 已存在的表补列；duplicate column 视为成功，保证线上平滑升级
      try {
        await conn.query('ALTER TABLE catalyst_analysis_task ADD COLUMN progress LONGTEXT NULL')
      } catch (err) {
        if (!/duplicate column/i.test(String((err && err.message) || err))) throw err
      }
    })().catch((err) => {
      tableReady = null
      throw err
    })
  }
  return tableReady
}

async function withTaskDb(env, fn) {
  const opts = connectionOptions(env)
  if (!opts) throw new Error('未配置数据库连接')
  const conn = await createConnection(opts)
  try {
    await ensureTable(conn)
    return await fn(conn)
  } finally {
    try { await conn.end() } catch { /* 忽略 */ }
  }
}

function parseJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

/** 把超过 10 分钟未更新的 running 标为 failed（兜底 waitUntil 被回收导致的卡死），60s 节流 */
async function sweepStale(conn) {
  if (Date.now() - lastSweep < 60 * 1000) return
  lastSweep = Date.now()
  const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const now = bjNow()
  try {
    await conn.query(
      "UPDATE catalyst_analysis_task SET status='failed', error='任务超时（超过10分钟未更新）', finished_at=?, updated_at=? " +
      "WHERE status='running' AND updated_at<?",
      [now, now, cutoff],
    )
  } catch { /* 清理失败不影响读取 */ }
}

/** 新建任务（调用方已先取消同 event_key 的旧任务） */
export async function insertTask(env, { id, eventKey, title, request, status = 'queued' }) {
  return withTaskDb(env, async (conn) => {
    const now = bjNow()
    await conn.query(
      'INSERT INTO catalyst_analysis_task (id, event_key, status, title, request, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, eventKey, status, String(title || '').slice(0, 255), JSON.stringify(request), now, now],
    )
    return true
  })
}

/** 同一消息的旧任务取消（不碰其他消息） */
export async function cancelByEvent(env, eventKey) {
  return withTaskDb(env, async (conn) => {
    const [r] = await conn.query(
      "UPDATE catalyst_analysis_task SET status='cancelled', updated_at=? " +
      "WHERE event_key=? AND status IN ('queued','running')",
      [bjNow(), eventKey],
    )
    return r.affectedRows || 0
  })
}

/** 抢占任务：仅 queued→running 成功才返回 true，防止重复执行 */
export async function claimTask(env, id) {
  return withTaskDb(env, async (conn) => {
    const now = bjNow()
    const [r] = await conn.query(
      "UPDATE catalyst_analysis_task SET status='running', started_at=?, updated_at=? WHERE id=? AND status='queued'",
      [now, now, id],
    )
    return (r.affectedRows || 0) > 0
  })
}

/** 更新状态；patch 可含 result / error / finishedAt */
export async function setTaskStatus(env, id, status, patch = {}) {
  return withTaskDb(env, async (conn) => {
    const fields = ['status=?', 'updated_at=?']
    const values = [status, bjNow()]
    if (patch.result !== undefined) { fields.push('result=?'); values.push(JSON.stringify(patch.result)) }
    if (patch.progress !== undefined) { fields.push('progress=?'); values.push(JSON.stringify(patch.progress)) }
    if (patch.error !== undefined) { fields.push('error=?'); values.push(String(patch.error).slice(0, 500)) }
    if (patch.finishedAt) { fields.push('finished_at=?'); values.push(patch.finishedAt) }
    else if (['done', 'failed', 'cancelled'].includes(status)) { fields.push('finished_at=?'); values.push(bjNow()) }
    values.push(id)
    await conn.query('UPDATE catalyst_analysis_task SET ' + fields.join(',') + ' WHERE id=?', values)
    return true
  })
}

/** 只更新进度快照（高频写入，不碰 status/result） */
export async function setTaskProgress(env, id, progress) {
  return withTaskDb(env, async (conn) => {
    await conn.query(
      'UPDATE catalyst_analysis_task SET progress=?, updated_at=? WHERE id=?',
      [JSON.stringify(progress), bjNow(), id],
    )
    return true
  })
}

function rowToTask(r) {
  return {
    id: r.id,
    eventKey: r.event_key,
    status: r.status,
    title: r.title || '',
    error: r.error || '',
    progress: parseJson(r.progress, null),
    createdAt: String(r.created_at || ''),
    updatedAt: String(r.updated_at || ''),
    startedAt: String(r.started_at || ''),
    finishedAt: String(r.finished_at || ''),
  }
}

/** 单个任务（含 request / result）；无记录返回 null */
export async function getTask(env, id) {
  return withTaskDb(env, async (conn) => {
    await sweepStale(conn)
    const [rows] = await conn.query('SELECT * FROM catalyst_analysis_task WHERE id=? LIMIT 1', [id])
    if (!rows.length) return null
    const r = rows[0]
    return {
      ...rowToTask(r),
      request: parseJson(r.request, {}),
      result: parseJson(r.result, null),
    }
  })
}

/** 任务列表（轻量：不含 request / result） */
export async function listTasks(env, status, limit) {
  return withTaskDb(env, async (conn) => {
    await sweepStale(conn)
    const params = []
    let where = ''
    if (['queued', 'running', 'done', 'failed', 'cancelled'].includes(status)) {
      where = ' WHERE status=?'
      params.push(status)
    }
    params.push(Math.min(100, Math.max(1, Number(limit) || 50)))
    const [rows] = await conn.query(
      'SELECT id,event_key,status,title,error,created_at,updated_at,started_at,finished_at ' +
      'FROM catalyst_analysis_task' + where + ' ORDER BY created_at DESC LIMIT ?',
      params,
    )
    return rows.map(rowToTask)
  })
}
