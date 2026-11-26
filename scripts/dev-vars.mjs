/**
 * .dev.vars 加密入库 / 解密落地（方案 B）
 *
 * 明文 .dev.vars 不入库；仓库里只放加密后的 .dev.vars.enc。
 * 口令通过安全渠道单独传递，不写入仓库。
 *
 * 用法：
 *   npm run vars:seal     # 维护者：把 .dev.vars 加密成 .dev.vars.enc
 *   npm run vars:open     # 新机器：用口令把 .dev.vars.enc 解密成 .dev.vars
 *
 * 口令来源：环境变量 DEV_VARS_KEY，或运行时交互输入（不回显）。
 * 算法：AES-256-GCM，密钥由 scrypt(salt, 口令) 派生。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAIN = path.join(ROOT, '.dev.vars')
const SEALED = path.join(ROOT, '.dev.vars.enc')
const N = 16384

function getPassphrase() {
  if (process.env.DEV_VARS_KEY) return process.env.DEV_VARS_KEY
  return readline.createInterface({ input: stdin, output: stdout }).question('解密口令: ')
}

function derive(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N, r: 8, p: 1 })
}

function seal() {
  if (!existsSync(PLAIN)) throw new Error('找不到 .dev.vars，先创建明文配置')
  const pass = getPassphrase()
  if (!pass) throw new Error('口令不能为空')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(pass, salt), iv)
  const data = Buffer.concat([
    cipher.update(readFileSync(PLAIN)),
    cipher.final(),
  ])
  const payload = {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  writeFileSync(SEALED, JSON.stringify(payload) + '\n', { mode: 0o644 })
  console.log('已加密:', SEALED)
}

function open() {
  if (!existsSync(SEALED)) throw new Error('找不到 .dev.vars.enc')
  const pass = getPassphrase()
  if (!pass) throw new Error('口令不能为空')
  const p = JSON.parse(readFileSync(SEALED, 'utf8'))
  if (p.v !== 1) throw new Error('不支持的加密版本: ' + p.v)
  const decipher = createDecipheriv('aes-256-gcm', derive(pass, Buffer.from(p.salt, 'base64')), Buffer.from(p.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(p.tag, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(p.data, 'base64')),
    decipher.final(),
  ])
  writeFileSync(PLAIN, plain, { mode: 0o600 })
  try { chmodSync(PLAIN, 0o600) } catch { /* Windows 忽略 */ }
  console.log('已解密:', PLAIN)
}

const cmd = process.argv[2]
if (cmd === 'seal') seal()
else if (cmd === 'open') open()
else throw new Error('用法: node scripts/dev-vars.mjs seal|open')
