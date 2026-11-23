import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, FEEDBACK_FILE } from './config.mjs'

export function appendFeedback(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const line = JSON.stringify({
    pushedAt: new Date().toISOString(),
    ...record,
    t1: null,
    t5: null,
    note: '',
  })
  fs.appendFileSync(FEEDBACK_FILE, line + '\n', 'utf8')
  return FEEDBACK_FILE
}

export function readFeedback() {
  try {
    return fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
