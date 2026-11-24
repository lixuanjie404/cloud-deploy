/**
 * mentionedStocks 确定性还原（LLM 只给线索，名称/代码以东财 suggest 校验为准）
 *
 * - name 精确命中 A 股 → 采纳官方名称+代码；否则按 raw（原文简称/拼音缩写）搜索
 * - 唯一候选 → 采纳；多候选 → 结合原文上下文做一次 LLM 选择题消歧
 * - 无 A 股匹配 → 丢弃（非 A 股公司/模型产品名）；网络失败 → 保留名称、代码留空
 * - LLM 输出的 code 一律不信任；按代码/名称去重
 */
import { suggestStocks, fetchCompanyProfile } from '../fetch/eastmoney.js'
import { chatJson, normalizeProviders } from './llm.mjs'

// 消歧优先用中文知识更强的免费模型，失败按序降级到默认通道
const DISAMB_MODEL = 'baidu/ernie-5.5-flash-preview:free'

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** 官方简称可能带 -W/-U/-C 后缀（如奥比中光-W），比较时去掉 */
const baseName = (s) => String(s || '').replace(/-[WUC]$/, '')

/** 多候选时让 LLM 结合原文做选择题（候选附东财 F10 真实主营简介）；失败返回空 Map */
async function disambiguate(pending, event, env) {
  const text = String((event && (event.content || event.title)) || '')
  const allCands = [...new Map(pending.flatMap((r) => r._cands).map((c) => [c.code, c])).values()]
  const profiles = await mapLimit(allCands, 6, async (c) => ({ code: c.code, profile: await fetchCompanyProfile(c.code) }))
  const profileMap = new Map(profiles.map((p) => [p.code, p.profile]))
  const items = pending.map((r, i) => {
    const at = text.indexOf(r.name)
    const snippet = at >= 0 ? text.slice(Math.max(0, at - 60), at + 60) : r.context || ''
    return {
      id: i + 1,
      raw: r.name,
      snippet,
      candidates: r._cands.map((c) => ({ name: c.name, profile: profileMap.get(c.code) || '' })),
    }
  })
  const messages = [
    {
      role: 'system',
      content: '你是 A 股证券简称消歧助手。每条给出简称、原文片段和候选公司（附东财 F10 权威主营简介）。任务：选出主营业务与原文片段行业语境最相关的一家（如"T链"指特斯拉 Optimus 人形机器人供应链，涉及零部件/轴承/丝杠/电机/传感器等；"数采链"指数据采集/传感器/电子皮肤环节）。严禁选择主营与语境明显无关的候选（如高速公路、纺织服装之于机器人供应链）；所有候选都无关时 name 给空字符串。严格输出一个 JSON 对象：{"picks":[{"id":1,"reason":"一句话理由","name":"候选名"}]}。name 必须逐字取自该条 candidates 的 name。不要输出其他文字。',
    },
    { role: 'user', content: `待消歧条目：\n${JSON.stringify(items)}` },
  ]
  const providers = normalizeProviders(env)
  if (env.OPENROUTER_API_KEY) {
    providers.unshift({ base: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: [DISAMB_MODEL] })
  }
  const dEnv = { ...env, LLM_PROVIDERS: JSON.stringify(providers) }
  try {
    const { parsed } = await chatJson(messages, dEnv, (p) => Array.isArray(p.picks))
    console.log('[resolve] 消歧', items.map((x) => x.raw).join(','), '→', parsed.picks.map((p) => p.name || '(空)').join(','))
    const map = new Map()
    for (const p of parsed.picks) {
      const it = items.find((x) => x.id === Number(p.id))
      if (it && p.name) map.set(it.raw, String(p.name))
    }
    return map
  } catch (err) {
    console.warn('[resolve] 消歧失败: ' + String(err.message || err).slice(0, 160))
    return new Map()
  }
}

export async function resolveMentionedStocks(entries, event, env) {
  const seenRaw = new Set()
  const clues = []
  for (const e of entries || []) {
    const raw = String((e && (e.raw || e.name)) || '').trim()
    if (!raw || seenRaw.has(raw)) continue
    seenRaw.add(raw)
    clues.push({ raw, name: String((e && e.name) || '').trim(), context: String((e && e.context) || '') })
  }
  if (!clues.length) return []

  const resolved = await mapLimit(clues, 6, async (e) => {
    // 1) 按原文简称/拼音缩写搜索
    const byRaw = await suggestStocks(e.raw)
    if (byRaw === null) return { ...e, name: e.name || e.raw, code: '', _state: 'neterr' }
    // 中文短名前缀过滤去模糊噪声；拼音缩写（纯字母）保留原结果
    const prefixed = /^[\u4e00-\u9fa5]+$/.test(e.raw) ? byRaw.filter((s) => s.name.startsWith(e.raw)) : byRaw
    const pool = prefixed.length ? prefixed : byRaw
    if (pool.length === 1) return { ...e, name: pool[0].name, code: pool[0].code, _state: 'ok' }
    // 2) 多候选一律消歧（存在≠语境正确，须按主营与上下文匹配）
    if (pool.length > 1) return { ...e, name: e.raw, code: '', _state: 'ambiguous', _cands: pool }
    // 3) 简称搜不到时，尝试 LLM 还原的全称精确命中
    if (e.name && e.name !== e.raw) {
      const byName = await suggestStocks(e.name)
      const hit = byName && (byName.find((s) => s.name === e.name) || byName.find((s) => baseName(s.name) === baseName(e.name)))
      if (hit) return { ...e, name: hit.name, code: hit.code, _state: 'ok' }
    }
    return { ...e, _state: 'nomatch' }
  })

  // 3) 多候选批量消歧
  const pending = resolved.filter((r) => r._state === 'ambiguous')
  if (pending.length) {
    const picks = await disambiguate(pending, event, env)
    for (const r of pending) {
      const pick = picks.get(r.name)
      const hit = pick && r._cands.find((c) => c.name === pick)
      if (hit) {
        r.name = hit.name
        r.code = hit.code
        r._state = 'ok'
      }
    }
  }

  // 4) 组装：无 A 股匹配的丢弃，其余按代码/名称去重
  const seen = new Set()
  const out = []
  for (const r of resolved) {
    if (r._state === 'nomatch') continue
    const key = r.code || r.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: r.name, code: r.code || '', context: r.context })
  }
  return out.slice(0, 40)
}