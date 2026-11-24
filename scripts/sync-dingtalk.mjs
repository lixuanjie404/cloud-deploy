/**
 * 钉钉群消息手动同步脚本（开发者主动触发）
 *
 *   npm run sync:dingtalk            # 同步最近 1 天
 *   npm run sync:dingtalk -- --days 7 # 同步最近 7 天
 *
 * 流程：dws CLI 拉群消息 → 解析为结构化记录 → upsert 到 dingtalk_message 表。
 * 按 message_id 去重（幂等，重复跑不重复写）。
 *
 * 配置来自项目上一层的 cloud-deploy.config.json（db / dws 段），见 scripts/config.mjs。
 * 注意：dws CLI 依赖本机钉钉 OAuth，故本脚本只能在本机跑，不能搬上 Workers。
 */
import { createConnection } from 'mysql2/promise'
import { dbConfig, dwsSettings } from './config.mjs'
import { fetchDingTalk } from './catalyst/sources.mjs'

// 解析命令行 --days N
function parseDays() {
  const i = process.argv.indexOf('--days')
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n >= 1 && n <= 365) return n
  }
  return 1
}

/** ISO/任意时间字符串 → 'YYYY-MM-DD HH:MM:SS'（北京时间 UTC+8） */
function toBeijingSqlTime(value) {
  if (!value) return ''
  let d = new Date(value)
  if (isNaN(d.getTime())) {
    // dws 有时给 'YYYY-MM-DD HH:MM:SS'（无时区），按北京时间解析
    d = new Date(value.replace(' ', 'T') + '+08:00')
  }
  if (isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate()) +
    ' ' + p(bj.getUTCHours()) + ':' + p(bj.getUTCMinutes()) + ':' + p(bj.getUTCSeconds())
}

function nowSqlTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
}

const UPSERT_SQL =
  'INSERT INTO dingtalk_message (message_id, create_time, sender, group_name, content, synced_at) ' +
  'VALUES ? AS new ON DUPLICATE KEY UPDATE ' +
  'create_time=new.create_time, sender=new.sender, group_name=new.group_name, ' +
  'content=new.content, synced_at=new.synced_at'

async function main() {
  const days = parseDays()
  const group = dwsSettings().group
  console.log('[sync] 开始拉取钉钉群消息：群=' + group + '，最近 ' + days + ' 天')

  // 1. 拉取（fetchDingTalk 内部已带降级，失败返回 []）
  const messages = await fetchDingTalk({ days, maxItems: 5000 })
  if (!messages.length) {
    console.log('[sync] 未拉到消息（可能休市/无新消息，或 dws 不可用），结束')
    return
  }
  console.log('[sync] 拉到 ' + messages.length + ' 条消息')

  // 2. 组装入库行
  const syncedAt = nowSqlTime()
  const rows = []
  for (const m of messages) {
    if (!m.id) continue
    rows.push([
      String(m.id).slice(0, 64),
      toBeijingSqlTime(m.time),
      String(m.sender || '').slice(0, 128),
      group.slice(0, 128),
      String(m.content || ''),
      syncedAt,
    ])
  }
  if (!rows.length) { console.log('[sync] 无有效消息，结束'); return }

  // 3. 写库（分批，幂等 upsert）
  const db = dbConfig()
  if (!db.host || !db.user || !db.database) {
    console.error('[sync] 未配置数据库：请检查 cloud-deploy.config.json 的 db 段')
    process.exitCode = 1
    return
  }
  const conn = await createConnection({
    host: db.host, port: db.port, user: db.user,
    password: db.password, database: db.database,
    disableEval: true, connectTimeout: 10000,
  })
  try {
    let written = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      await conn.query(UPSERT_SQL, [chunk])
      written += chunk.length
    }
    console.log('[sync] 完成：写入/更新 ' + written + ' 条（按 message_id 去重）')
  } finally {
    try { await conn.end() } catch { /* 忽略关闭异常 */ }
  }
}

main().catch((err) => {
  console.error('[sync] 失败：', err.code || err.message)
  process.exitCode = 1
})
