import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

// 密钥只从既有配置读取，绝不写入代码/仓库
const LLM_CONFIG = path.join(HOME, 'lxj', 'ai+stock', 'config.json')
const XINHUA_CONFIG = path.join(HOME, 'lxj', 'ai-stock', 'config.json')

export const DWS_ENTRY = path.join(
  HOME, '.workbuddy', 'binaries', 'node', 'cli-connector-packages',
  'node_modules', 'dingtalk-workspace-cli', 'bin', 'dws.js'
)
export const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data')
export const FEEDBACK_FILE = path.join(DATA_DIR, 'catalyst-feedback.jsonl')
export const GROUP_NAME = process.env.CATALYST_GROUP || '每日调研──破晓📈'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function llmSettings() {
  const cfg = readJson(LLM_CONFIG)
  const ai = cfg.ai || {}
  const key = String(process.env.CATALYST_LLM_KEY || ai.api_key || '')
  if (!key) throw new Error('未找到智谱 API Key：请配置 CATALYST_LLM_KEY 或 ' + LLM_CONFIG)
  return {
    key,
    base: process.env.CATALYST_LLM_BASE || 'https://open.bigmodel.cn/api/paas/v4',
    // glm-4-flash 免费但太弱，长板块列表下会跑偏（把"猪肉概念"当主题）；
    // glm-4.5-flash 同样免费且质量好，作为首选；多个模型按序降级。
    models: (process.env.CATALYST_MODELS || 'glm-4.5-flash,glm-4-flash,glm-4.7-flash')
      .split(',').map((s) => s.trim()).filter(Boolean),
    timeout: Number(process.env.CATALYST_LLM_TIMEOUT || 120000),
  }
}

export function xinhuaSettings() {
  const cfg = readJson(XINHUA_CONFIG)
  const xh = cfg.xinhua || {}
  const key = String(process.env.CATALYST_XH_KEY || xh.api_key || '')
  if (!key) throw new Error('未找到新华财经 API Key：请配置 CATALYST_XH_KEY 或 ' + XINHUA_CONFIG)
  return {
    key,
    url: 'https://mcp.cnfic.com.cn/mcp-servers/xhcj-mcp-announcements-news-policy',
    protocol: '2025-03-26',
    timeout: Number(process.env.CATALYST_XH_TIMEOUT || 60000),
  }
}
