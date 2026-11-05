/**
 * 本地开发启动器：解决 wrangler dev 因 Hyperdrive 缺少本地连接串而直接报错退出。
 *
 * 背景：
 * - wrangler 4.20.5 在本地模式下，只要 wrangler.jsonc 里有 hyperdrive 绑定，
 *   就要求 WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING> 或配置里的
 *   localConnectionString 存在，否则启动即抛错。
 * - 报错文案里的 "Postgres" 是 wrangler 的通用模板，本项目用的是 MySQL（mysql2）。
 *   miniflare 4.x 同时支持 postgresql:// / postgres:// / mysql://，不必装 Postgres。
 * - 该环境变量是 wrangler 自己从进程环境读的：shell 或 .env 有效，
 *   .dev.vars 只会注入 Worker 运行时，对这处校验无效。
 *
 * 本脚本从 .dev.vars / .env 的 MYSQL_*（或 DB_*）自动拼出 mysql:// 连接串，
 * 避免把明文口令写进受版本控制的 wrangler.jsonc。
 * 命令行参数原样透传：npm run dev -- --remote / --port 8799
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BINDING = 'HYPERDRIVE'
const ENV_KEY = `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_${BINDING}`
const FALLBACK = 'mysql://dev:dev@127.0.0.1:3306/dev'

function parseDotEnv(file) {
  const full = path.join(root, file)
  if (!existsSync(full)) return {}
  const vars = {}
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    let value = match[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    vars[match[1]] = value
  }
  return vars
}

function buildMysqlUri(vars) {
  const host = vars.DB_HOST || vars.MYSQL_HOST
  const user = vars.DB_USER || vars.MYSQL_USERNAME
  const password = vars.DB_PASSWORD ?? vars.MYSQL_PASSWORD
  const database = vars.DB_NAME || vars.MYSQL_DATABASE
  const port = vars.DB_PORT || vars.MYSQL_PORT || '3306'
  if (!host || !user || !password || !database) return null
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

let connectionString = process.env[ENV_KEY]
let source = '进程环境变量'

if (!connectionString) {
  connectionString = parseDotEnv('.env')[ENV_KEY]
  if (connectionString) source = '.env'
}

if (!connectionString) {
  connectionString = buildMysqlUri({ ...parseDotEnv('.dev.vars'), ...parseDotEnv('.env') })
  if (connectionString) source = '.dev.vars / .env 的 MYSQL_*（或 DB_*）'
}

if (!connectionString) {
  // 没有数据库也要能起服务：静态页与 /api/* 代理正常，DB 相关接口连不上库。
  connectionString = FALLBACK
  source = '占位值（未配置数据库，/api/db/* 等接口不可用）'
  console.warn('[dev] 未找到数据库连接信息，使用占位连接串启动；数据库接口会连不上。')
}

// 只打印来源，不打印连接串（含口令）
console.log(`[dev] ${ENV_KEY} 来源：${source}`)

const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
if (!existsSync(wranglerBin)) {
  console.error('[dev] 找不到 wrangler，请先执行 npm install')
  process.exit(1)
}

const child = spawn(process.execPath, [wranglerBin, 'dev', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, [ENV_KEY]: connectionString },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  else process.exit(code ?? 0)
})
