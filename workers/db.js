/**
 * MySQL 只读接入层（Cloudflare Workers）
 *
 * 连接方式优先级：
 *   1. env.HYPERDRIVE  —— Cloudflare Hyperdrive 绑定（生产推荐，自带连接池与查询缓存）
 *   2. env.DB_*        —— 直连参数（本地调试或未启用 Hyperdrive 时）
 *
 * 安全边界：
 *   - 只允许 GET，只读
 *   - 表名/列名走严格标识符校验，且必须是库里存在的表
 *   - 可选白名单 env.DB_TABLES（逗号分隔），设置后只能读这些表
 *   - LIMIT 上限 500，禁止任意 SQL 透传
 */

import { createConnection } from 'mysql2/promise'

const IDENT = /^[A-Za-z0-9_$]{1,64}$/
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50

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

function connectionOptions(env) {
  if (env.HYPERDRIVE && env.HYPERDRIVE.host) {
    return {
      host: env.HYPERDRIVE.host,
      port: Number(env.HYPERDRIVE.port) || 3306,
      user: env.HYPERDRIVE.user,
      password: env.HYPERDRIVE.password,
      database: env.HYPERDRIVE.database,
      disableEval: true, // Workers 无 eval，mysql2 必须走静态解析
      dateStrings: true,
      connectTimeout: 10000,
    }
  }

  if (env.DB_HOST) {
    const opts = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT) || 3306,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      disableEval: true,
      dateStrings: true,
      connectTimeout: 10000,
    }
    if (env.DB_SSL === 'on') opts.ssl = { rejectUnauthorized: false }
    return opts
  }

  return null
}

async function withConnection(env, fn) {
  const opts = connectionOptions(env)
  if (!opts) {
    const err = new Error('未配置数据库：请添加 HYPERDRIVE 绑定，或设置 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME')
    err.status = 503
    throw err
  }
  const conn = await createConnection(opts)
  try {
    return await fn(conn)
  } finally {
    try { await conn.end() } catch { /* 关闭失败不覆盖原始错误 */ }
  }
}

function allowlist(env) {
  return String(env.DB_TABLES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function tableNames(conn) {
  const [rows] = await conn.query('SHOW TABLES')
  return rows.map((r) => Object.values(r)[0])
}

async function columnNames(conn, table) {
  const [rows] = await conn.query('SHOW COLUMNS FROM ??', [table])
  return rows.map((r) => r.Field)
}

function intParam(value, fallback, { min = 0, max = MAX_LIMIT } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

/** GET /api/db/health —— 连通性与版本 */
async function health(env) {
  return withConnection(env, async (conn) => {
    const [rows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db, NOW() AS server_time')
    return json({
      ok: true,
      source: env.HYPERDRIVE && env.HYPERDRIVE.host ? 'hyperdrive' : 'direct',
      ...rows[0],
    })
  })
}

/** GET /api/db/tables —— 列出可用表 */
async function tables(env) {
  return withConnection(env, async (conn) => {
    const all = await tableNames(conn)
    const white = allowlist(env)
    const usable = white.length ? all.filter((t) => white.includes(t)) : all
    return json({
      ok: true,
      total: all.length,
      allowlist: white.length ? white : null,
      tables: usable,
    })
  })
}

/** GET /api/db/table/:name?limit=&offset=&order=&dir=&fields= —— 读取一张表 */
async function tableData(env, name, url) {
  if (!IDENT.test(name)) return json({ ok: false, error: '非法表名' }, 400)

  const white = allowlist(env)
  if (white.length && !white.includes(name)) {
    return json({ ok: false, error: '该表不在 DB_TABLES 白名单内' }, 403)
  }

  const limit = intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT })
  const offset = intParam(url.searchParams.get('offset'), 0, { min: 0, max: 1e9 })
  if (limit === null || offset === null) {
    return json({ ok: false, error: `limit 需为 1-${MAX_LIMIT} 的整数，offset 需为非负整数` }, 400)
  }

  const dir = (url.searchParams.get('dir') || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
  const order = url.searchParams.get('order')
  const fieldsRaw = url.searchParams.get('fields')

  return withConnection(env, async (conn) => {
    const exists = (await tableNames(conn)).includes(name)
    if (!exists) return json({ ok: false, error: `表 ${name} 不存在` }, 404)

    const columns = await columnNames(conn, name)

    let fields = '*'
    if (fieldsRaw) {
      const picked = fieldsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = picked.filter((f) => !IDENT.test(f) || !columns.includes(f))
      if (bad.length) return json({ ok: false, error: `未知字段: ${bad.join(', ')}` }, 400)
      fields = picked.map((f) => `\`${f}\``).join(', ')
    }

    if (order && (!IDENT.test(order) || !columns.includes(order))) {
      return json({ ok: false, error: `未知排序字段: ${order}` }, 400)
    }

    const sql = order
      ? `SELECT ${fields} FROM ?? ORDER BY \`${order}\` ${dir} LIMIT ? OFFSET ?`
      : `SELECT ${fields} FROM ?? LIMIT ? OFFSET ?`

    const [rows] = await conn.query(sql, [name, limit, offset])
    return json(
      { ok: true, table: name, columns, limit, offset, count: rows.length, rows },
      200,
      'public, max-age=30, s-maxage=60',
    )
  })
}

export async function handleDbRequest(request, env, url) {
  if (request.method !== 'GET') {
    return json({ ok: false, error: '仅支持 GET' }, 405)
  }

  try {
    if (url.pathname === '/api/db/health') return await health(env)
    if (url.pathname === '/api/db/tables') return await tables(env)

    const m = url.pathname.match(/^\/api\/db\/table\/([^/]+)$/)
    if (m) return await tableData(env, decodeURIComponent(m[1]), url)

    return json({ ok: false, error: '未知接口。可用：/api/db/health、/api/db/tables、/api/db/table/:name' }, 404)
  } catch (err) {
    const status = err && err.status ? err.status : 500
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, status)
  }
}
