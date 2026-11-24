/**
 * LLM 推演调用（从 catalyst/llm.mjs 平移）
 *
 * 配置优先级：
 * 1) env.LLM_PROVIDERS —— JSON 数组，每项 {base, keyEnv, models, extraBody?}，按序降级；
 *    keyEnv 指向 secret 名（如 OPENROUTER_API_KEY），未配置密钥的通道自动跳过。
 * 2) env.LLM_BASE / LLM_API_KEY / LLM_MODELS —— 旧版单通道配置，保持兼容。
 */

function extractJson(text) {
  const s = String(text || '').trim()
  const clean = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(clean) } catch { /* 继续 */ }
  const start = clean.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
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
        try { return JSON.parse(clean.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  if (depth > 0) {
    try { return JSON.parse(clean + '}'.repeat(depth)) } catch { return null }
  }
  return null
}

/** 解析通道配置：优先 LLM_PROVIDERS（JSON 数组），否则回退旧版单通道 env */
export function normalizeProviders(env) {
  if (env.LLM_PROVIDERS) {
    try {
      const raw = JSON.parse(env.LLM_PROVIDERS)
      if (Array.isArray(raw) && raw.length) {
        const list = raw.map((p) => ({
          base: String(p.base || '').replace(/\/+$/, ''),
          key: String(p.keyEnv ? (env[p.keyEnv] || '') : (p.key || '')),
          models: Array.isArray(p.models)
            ? p.models.map(String).filter(Boolean)
            : String(p.models || '').split(',').map((s) => s.trim()).filter(Boolean),
          extraBody: p.extraBody && typeof p.extraBody === 'object' ? p.extraBody : null,
        })).filter((p) => p.base && p.key && p.models.length)
        if (list.length) return list
      }
    } catch (err) {
      console.warn('[llm] LLM_PROVIDERS 解析失败，回退旧配置: ' + String(err.message || err))
    }
  }
  const key = env.LLM_API_KEY
  if (!key) return []
  return [{
    base: String(env.LLM_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    key,
    models: String(env.LLM_MODELS || 'glm-4-flash').split(',').map((s) => s.trim()).filter(Boolean),
    extraBody: null,
  }]
}

/** 通用 JSON 对话：按 通道 → 模型 顺序降级，输出须通过 isValid 校验 */
export async function chatJson(messages, env, isValid) {
  const providers = normalizeProviders(env)
  if (!providers.length) throw new Error('未配置 LLM 凭证（LLM_PROVIDERS / LLM_API_KEY）')
  const timeout = Number(env.LLM_TIMEOUT || 120000)
  const check = typeof isValid === 'function' ? isValid : () => true
  let lastErr = ''

  // 每个组合最多 2 次尝试（限流/鉴权/服务端错误不重试，直接换下一个）
  for (const provider of providers) {
    for (const model of provider.models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const body = {
            model,
            messages,
            temperature: 0.2,
            max_tokens: 4000,
            ...(provider.extraBody || {}),
          }
          const res = await fetch(provider.base + '/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + provider.key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout),
          })
          if (!res.ok) {
            lastErr = `${provider.base} ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`
            break
          }
          const data = await res.json()
          const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
          const parsed = extractJson(content)
          if (!parsed || !check(parsed)) {
            throw new Error('输出不是合法 JSON schema: ' + String(content).slice(0, 120))
          }
          return { parsed, model: data.model || model }
        } catch (err) {
          lastErr = `${provider.base} ${model}: ${String(err.message || err).slice(0, 200)}`
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1200))
            continue
          }
        }
        break
      }
      console.warn('[llm] 尝试失败，切换下一个: ' + lastErr.slice(0, 200))
    }
  }
  throw new Error('LLM 所有通道均失败: ' + lastErr)
}

export async function reasonEvent(messages, env) {
  const { parsed, model } = await chatJson(messages, env, (p) => Array.isArray(p.layers))
  return { ...parsed, _model: model }
}
