/**
 * 日线落表模块（Cloudflare Workers）
 *
 * 写入只发生在后台任务（Cron 处理器，或读接口通过 ctx.waitUntil 调度的 backfill.js 补全）；
 * HTTP 响应本身只用表内已有数据，不阻塞等待写库。
 * 表结构：主键 (code, adjust, trade_date)。
 *
 * 口径约定（本系统）：
 *   - 标的：code = 6 位数字，adjust = 'raw'
 *   - 指数：code = 6 位数字，adjust = 'idx'（如 000300 / idx）
 */

import { createConnection } from 'mysql2/promise'
import { connectionOptions } from './kline.js'

const UPSERT_SQL =
  'INSERT INTO daily_bar (code, adjust, trade_date, open, high, low, close, volume, amount) ' +
  'VALUES ? AS new ON DUPLICATE KEY UPDATE ' +
  'open=new.open, high=new.high, low=new.low, close=new.close, volume=new.volume, amount=new.amount'

/** 建立连接（复用 kline.js 的 HYPERDRIVE / DB_* 逻辑） */
async function connect(env) {
  const opts = connectionOptions(env)
  if (!opts) throw new Error('未配置数据库连接（HYPERDRIVE 或 DB_* / MYSQL_*）')
  // DB_* 直连模式返回 { uri, ssl, ... }：uri 必须作为 createConnection 的独立参数传入，
  // 否则 mysql2 不认 uri 键（会连到默认 localhost 且不走 TLS）；Hyperdrive 分支已是对象形态
  if (opts && typeof opts.uri === 'string') {
    const { uri, ...rest } = opts
    return createConnection(uri, rest)
  }
  return createConnection(opts)
}

function toRow(code, adjust, b) {
  const date = String(b.date).slice(0, 10)
  return [code, adjust, date, b.open, b.high, b.low, b.close, b.volume, b.amount]
}

/**
 * 批量 upsert 日线（幂等，同主键覆盖）
 * @param {string} code 6 位代码
 * @param {'raw'|'idx'} adjust 口径
 * @param {Array} bars [{date,open,high,low,close,volume,amount}]
 * @returns {Promise<number>} 写入行数
 */
export async function upsertDailyBars(env, code, adjust, bars) {
  if (!Array.isArray(bars) || !bars.length) return 0
  const rows = bars.map((b) => toRow(code, adjust, b))
  const conn = await connect(env)
  try {
    // 分批，避免单条 SQL 过大（每批 500 行）
    let written = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      await conn.query(UPSERT_SQL, [chunk])
      written += chunk.length
    }
    return written
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

function rowToBar(r) {
  return {
    date: String(r.trade_date).slice(0, 10),
    open: Number(r.open),
    close: Number(r.close),
    high: Number(r.high),
    low: Number(r.low),
    volume: Number(r.volume),
    amount: Number(r.amount),
  }
}

/**
 * 读取日线（按时间升序），返回与 fetchDaily 一致的 bars 结构
 * @returns {Promise<Array>}
 */
export async function readDailyBars(env, code, adjust, limit = 90) {
  const conn = await connect(env)
  try {
    const [rows] = await conn.query(READ_SQL, [code, adjust, limit])
    return rows.map(rowToBar).filter((b) => b.close > 0)
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

/**
 * 批量读取多个序列（单连接、单条 UNION ALL SQL），避免逐序列查询的多次远端往返。
 * @param {Array<{code:string,adjust:string}>} specs
 * @returns {Promise<Map<string, Array>>} key = code + '|' + adjust → bars[]（升序）
 */
export async function readDailyBarsBatch(env, specs, limit = 90) {
  if (!specs || !specs.length) return new Map()
  const conn = await connect(env)
  try {
    return await queryBarsBatch(conn, specs, limit)
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

const BAR_COLS = 'code, adjust, trade_date, open, high, low, close, volume, amount'

async function queryBarsBatch(conn, specs, limit) {
  const part = '(SELECT ' + BAR_COLS + ' FROM daily_bar WHERE code = ? AND adjust = ? ORDER BY trade_date DESC LIMIT ?)'
  const sql = specs.map(() => part).join(' UNION ALL ')
  const params = specs.flatMap((s) => [s.code, s.adjust, limit])
  const [rows] = await conn.query(sql, params)
  const groups = new Map()
  for (const r of rows) {
    const key = r.code + '|' + r.adjust
    let arr = groups.get(key)
    if (!arr) { arr = []; groups.set(key, arr) }
    arr.push(r)
  }
  const out = new Map()
  for (const spec of specs) {
    const key = spec.code + '|' + spec.adjust
    const arr = (groups.get(key) || []).reverse()
    out.set(key, arr.map(rowToBar).filter((b) => b.close > 0))
  }
  return out
}

/**
 * 候选池专用：单连接一次读齐日线批量 + 名称映射（两次查询，一次握手）。
 * @returns {Promise<{bars:Map<string,Array>, names:Map<string,string>}>}
 */
export async function readBarsWithNames(env, specs, codes, limit = 90) {
  const conn = await connect(env)
  try {
    const bars = await queryBarsBatch(conn, specs, limit)
    const names = new Map()
    if (codes && codes.length) {
      const ph = codes.map(() => '?').join(',')
      const [rows] = await conn.query('SELECT code, name FROM stock_list WHERE code IN (' + ph + ')', codes)
      for (const r of rows) names.set(r.code, r.name)
    }
    return { bars, names }
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

const HOT_DDL =
  'CREATE TABLE IF NOT EXISTS hot_stock (' +
  ' source VARCHAR(16) NOT NULL,' +
  ' code CHAR(6) NOT NULL,' +
  " name VARCHAR(64) NOT NULL DEFAULT ''," +
  ' rank_no INT NOT NULL,' +
  ' heat DOUBLE NOT NULL DEFAULT 0,' +
  ' fetched_at DATETIME NOT NULL,' +
  ' PRIMARY KEY (source, code)' +
  ') DEFAULT CHARSET=utf8mb4'

const HOT_UPSERT_SQL =
  'INSERT INTO hot_stock (source, code, name, rank_no, heat, fetched_at) VALUES ? AS new ' +
  'ON DUPLICATE KEY UPDATE name=new.name, rank_no=new.rank_no, heat=new.heat, fetched_at=new.fetched_at'

/**
 * 整源刷新热榜（每小时 Cron 调用）：upsert 本批 + 删除掉榜标的 + 清理 3 天前的陈旧行。
 * items 为空视为本源拉取失败，不动表内旧数据。
 * @param {string} source 源 key（em/ths/xq/tgb）
 * @param {Array<{code,name,rank,heat}>} items
 * @returns {Promise<number>} 写入行数
 */
export async function upsertHotStocks(env, source, items) {
  if (!Array.isArray(items) || !items.length) return 0
  const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const rows = items.map((it) => [source, it.code, it.name || '', it.rank, it.heat || 0, now])
  const conn = await connect(env)
  try {
    await conn.query(HOT_DDL)
    await conn.query(HOT_UPSERT_SQL, [rows])
    const ph = items.map(() => '?').join(',')
    await conn.query(
      'DELETE FROM hot_stock WHERE source = ? AND code NOT IN (' + ph + ')',
      [source, ...items.map((it) => it.code)],
    )
    await conn.query('DELETE FROM hot_stock WHERE fetched_at < DATE_SUB(?, INTERVAL 3 DAY)', [now])
    return rows.length
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

/**
 * 读全部热榜行（每源最新一批，按源内名次升序）
 * @returns {Promise<Array<{source,code,name,rank,heat,fetchedAt}>>}
 */
export async function readHotStocks(env) {
  const conn = await connect(env)
  try {
    const [rows] = await conn.query(
      "SELECT source, code, name, rank_no, heat, DATE_FORMAT(fetched_at, '%Y-%m-%d %H:%i') AS fetched_at FROM hot_stock ORDER BY source, rank_no",
    )
    return rows.map((r) => ({
      source: r.source,
      code: r.code,
      name: r.name,
      rank: Number(r.rank_no),
      heat: Number(r.heat),
      fetchedAt: String(r.fetched_at),
    }))
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

/**
 * 返回某序列的最新日期（用于增量判断），无数据返回 null
 */
export async function latestDate(env, code, adjust) {
  const conn = await connect(env)
  try {
    const [rows] = await conn.query(
      'SELECT MAX(trade_date) AS d FROM daily_bar WHERE code = ? AND adjust = ?',
      [code, adjust],
    )
    return rows[0] && rows[0].d ? String(rows[0].d).slice(0, 10) : null
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}
