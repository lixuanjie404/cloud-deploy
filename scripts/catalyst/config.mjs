/**
 * catalyst 本地配置适配层
 *
 * 所有外部配置统一来自项目上一层的 cloud-deploy.config.json（见 scripts/config.mjs）。
 * 本模块只补充 catalyst 自身的数据目录常量，外部配置统一由 scripts/config.mjs 加载。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { llmSettings, xinhuaSettings, dwsSettings } from '../config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.join(HERE, 'data')
export const FEEDBACK_FILE = path.join(DATA_DIR, 'catalyst-feedback.jsonl')

const dws = dwsSettings()
export const DWS_ENTRY = dws.entry
export const GROUP_NAME = dws.group

export { llmSettings, xinhuaSettings }
