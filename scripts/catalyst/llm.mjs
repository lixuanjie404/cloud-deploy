import { llmSettings } from './config.mjs'

function extractJson(text) {
  const s = String(text || '').trim()
  const clean = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(clean)
  } catch {
    // 从第一个 { 开始做括号配平，截出最外层对象
    const start = clean.indexOf('{')
    if (start < 0) return null
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < clean.length; i++) {
      const c = clean[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(clean.slice(start, i + 1))
          } catch {
            return null
          }
        }
      }
    }
    // 尾部被 max_tokens 截断：按未闭合深度补齐括号再试
    if (depth > 0) {
      const patched = clean + '}'.repeat(depth)
      try {
        return JSON.parse(patched)
      } catch {
        return null
      }
    }
    return null
  }
}

export async function reasonEvent(messages) {
  const cfg = llmSettings()
  const models = cfg.models && cfg.models.length ? cfg.models : ['glm-4-flash']
  const body = {
    messages,
    temperature: 0.2,
    max_tokens: 3000,
  }
  let lastErr = ''
  // 先遍历模型；每个模型遇到 429/403/5xx 就快速切下一个，避免卡在同一繁忙模型上
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]
    body.model = model
    let switched = false
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${cfg.base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeout),
        })
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          const detail = (await res.text()).slice(0, 200)
          lastErr = `${model} HTTP ${res.status}: ${detail}`
          // 限流/无权/服务错误：短退避后换下一个模型，不再在此模型死等
          if (mi < models.length - 1) {
            switched = true
            break
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, [0, 5000, 12000][attempt]))
            continue
          }
          throw new Error(`LLM ${lastErr}`)
        }
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300)
          throw new Error(`LLM HTTP ${res.status}: ${detail}`)
        }
        const data = await res.json()
        const content = data?.choices?.[0]?.message?.content || ''
        const parsed = extractJson(content)
        if (!parsed || !Array.isArray(parsed.layers)) {
          const err = new Error('LLM 输出不是合法 JSON schema')
          err.raw = content
          throw err
        }
        return { ...parsed, _model: data.model || model }
      } catch (err) {
        lastErr = String(err.message || err)
        if (attempt >= 2) {
          if (mi < models.length - 1) { switched = true; break }
          throw err
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
    if (switched) continue
  }
  throw new Error(`LLM 所有模型均失败: ${lastErr}`)
}
