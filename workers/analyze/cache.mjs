/**
 * 催化推演 AI 分析结果缓存（Cloudflare Workers / MySQL via Hyperdrive）
 *
 * - 同一事件（钉钉 message_id 等）重复点击时直接返回缓存，不再调用 LLM；
 * - 前端传 refresh=true 时跳过读取、重新分析并覆盖缓存；
 * - 缓存读写失败一律降级为「无缓存」，不影响分析主流程。
 */
import { createConnection } from 'mysql2/promise'
import { connectionOptions } from '../kline.js'

const CREATE_SQL =
  'CREATE TABLE IF NOT EXISTS catalyst_analysis_cache (' +
  'event_key VARCHAR(96) NOT NULL PRIMARY KEY,' +
  'payload LONGTEXT NOT NULL,' +
  'model VARCHAR(80) NOT NULL DEFAULT \'\',' +
  'created_at DATETIME NOT NULL,' +
  'updated_at DATETIME NOT NULL,' +
  'KEY ix_cat_cache_updated (updated_at)' +
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

let tableReady = null

function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/** 建表只做一次；失败后清空 promise，下次请求可重试 */
function ensureTable(conn) {
  if (!tableReady) {
    tableReady = conn.query(CREATE_SQL).catch((err) => {
      tableReady = null
      throw err
    })
  }
  return tableReady
}

async function withCacheDb(env, fn) {
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

function hash32(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 事件 → 稳定缓存键：优先 id，其次对标题/正文取哈希 */
export function eventKey(event) {
  const id = event && (event.id || event.message_id || event.messageId)
  if (id) return 'id:' + String(event.source || '') + ':' + String(id).slice(0, 80)
  const raw = JSON.stringify([
    (event && event.source) || '',
    (event && event.title) || '',
    (event && event.content) || '',
    (event && event.time) || '',
  ])
  return 'h:' + hash32(raw, 2166136261) + hash32(raw, 0x811c9dc5 ^ 0x9e3779b9)
}

/** 命中返回 { payload, cachedAt }，未命中或出错返回 null */
export async function readAnalysisCache(env, key) {
  try {
    return await withCacheDb(env, async (conn) => {
      const [rows] = await conn.query(
        'SELECT payload, created_at, updated_at FROM catalyst_analysis_cache WHERE event_key = ? LIMIT 1',
        [key],
      )
      if (!rows.length) return null
      let payload
      try { payload = JSON.parse(rows[0].payload) } catch { return null }
      return {
        payload,
        cachedAt: String(rows[0].updated_at || rows[0].created_at || ''),
        createdAt: String(rows[0].created_at || ''),
      }
    })
  } catch (err) {
    console.warn('[analyze-cache] 读取失败，跳过缓存: ' + String(err.message || err).slice(0, 200))
    return null
  }
}

/** 写入/覆盖缓存；失败不影响分析结果返回 */
export async function writeAnalysisCache(env, key, payload) {
  try {
    await withCacheDb(env, async (conn) => {
      const now = bjNow()
      await conn.query(
        'INSERT INTO catalyst_analysis_cache (event_key, payload, model, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ' +
        'payload=VALUES(payload), model=VALUES(model), updated_at=VALUES(updated_at)',
        [key, JSON.stringify(payload), String(payload.model || '').slice(0, 80), now, now],
      )
    })
  } catch (err) {
    console.warn('[analyze-cache] 写入失败，结果未缓存: ' + String(err.message || err).slice(0, 200))
  }
}
