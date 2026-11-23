import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DWS_ENTRY, GROUP_NAME } from './config.mjs'

const execFileAsync = promisify(execFile)

// 默认只预览；只有显式 --send 才真实发送（用户运行命令本身即确认）
export async function pushToGroup(content, { send = false } = {}) {
  const args = [
    DWS_ENTRY, 'chat', '+send-to-group',
    '--group', GROUP_NAME,
    '--content', content,
    '--format', 'json',
  ]
  if (!send) args.push('--dry-run')
  else args.push('--yes')
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
    })
    return { ok: true, output: (stdout || stderr || '').trim().slice(0, 500) }
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 300) }
  }
}
