/**
 * 统一配置加载器（项目内共享）
 *
 * 配置文件位于项目上一层：../cloud-deploy.config.json
 * 新机器运行步骤：拉取项目 → 把配置文件拷到项目上一层 → npm run dev
 *
 * 优先级：环境变量 > 配置文件 > 内置默认值
 * 环境变量覆盖让同一份代码既能本地跑（读文件），也能部署到 Workers/secrets（读环境变量）。
 *
 * 注意：本文件不含任何密钥明文，只读配置文件/环境变量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..')
export const CONFIG_FILE = process.env.CLOUD_DEPLOY_CONFIG ||
  path.join(path.dirname(PROJECT_ROOT), 'cloud-deploy.config.json')

let cache = null

function readConfig() {
  if (cache) return cache
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    // 配置文件缺失时仅依赖环境变量/默认值，不抛错
  }
  cache = file
  return cache
}

/** 取一个配置项：envName 环境变量优先，否则配置文件点路径，否则默认值 */
function pick(envName, fileKeys, fallback = '') {
  if (envName && process.env[envName] != null && process.env[envName] !== '') {
    return process.env[envName]
  }
  let cur = readConfig()
  for (const k of fileKeys) {
    if (cur == null) return fallback
    cur = cur[k]
  }
  return cur == null || cur === '' ? fallback : cur
}

/** 数据库配置（本地 wrangler dev 用；生产走 Hyperdrive 绑定） */
export function dbConfig() {
  return {
    host: pick('MYSQL_HOST', ['db', 'host']),
    port: Number(pick('MYSQL_PORT', ['db', 'port'], 3306)),
    user: pick('MYSQL_USERNAME', ['db', 'user']),
    password: pick('MYSQL_PASSWORD', ['db', 'password']),
    database: pick('MYSQL_DATABASE', ['db', 'database']),
  }
}

/** LLM（智谱兼容接口）配置 */
export function llmSettings() {
  const key = pick('CATALYST_LLM_KEY', ['llm', 'key'])
  if (!key) throw new Error('未找到 API Key：请配置 ' + CONFIG_FILE + ' 的 llm.key，或设置 CATALYST_LLM_KEY')
  return {
    key,
    base: pick('CATALYST_LLM_BASE', ['llm', 'base'], 'https://open.bigmodel.cn/api/paas/v4'),
    models: String(pick('CATALYST_MODELS', ['llm', 'models'], 'glm-4-flash'))
      .split(',').map((s) => s.trim()).filter(Boolean),
    timeout: Number(pick('CATALYST_LLM_TIMEOUT', ['llm', 'timeout'], 120000)),
  }
}

/** 新华财经配置 */
export function xinhuaSettings() {
  const key = pick('CATALYST_XH_KEY', ['xinhua', 'key'])
  if (!key) throw new Error('未找到新华财经 Key：请配置 ' + CONFIG_FILE + ' 的 xinhua.key，或设置 CATALYST_XH_KEY')
  return {
    key,
    url: 'https://mcp.cnfic.com.cn/mcp-servers/xhcj-mcp-announcements-news-policy',
    protocol: '2025-03-26',
    timeout: Number(pick('CATALYST_XH_TIMEOUT', ['xinhua', 'timeout'], 60000)),
  }
}

/** 钉钉 CLI 与群 */
export function dwsSettings() {
  return {
    entry: pick('CATALYST_DWS_ENTRY', ['dws', 'entry']),
    group: pick('CATALYST_GROUP', ['dws', 'group'], '每日调研──破晓📈'),
  }
}

/** 关注的标的清单（逗号分隔） */
export function watchlist() {
  return String(pick('WATCHLIST', ['watchlist'], '600127,002242,600519,300750,000002'))
}

export { PROJECT_ROOT }
