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

/** 单次调用：按 models 顺序降级，返回首个合法的 layers 结果 */
async function callOnce(messages, cfg, temperature) {
  const body = { messages, temperature, max_tokens: 3000 }
  let lastErr = ''
  for (let mi = 0; mi < cfg.models.length; mi++) {
    const model = cfg.models[mi]
    body.model = model
    let switched = false
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(cfg.base.replace(/\/+$/, '') + '/chat/completions', {
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
          if (mi < cfg.models.length - 1) {
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
        return { parsed, model: data.model || model, raw: content }
      } catch (err) {
        lastErr = String(err.message || err)
        if (attempt >= 2) {
          if (mi < cfg.models.length - 1) {
            switched = true
            break
          }
          throw err
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
    if (switched) continue
  }
  throw new Error(`LLM 所有模型均失败: ${lastErr}`)
}

/** 保持原行为：单次采样 */
export async function reasonEvent(messages) {
  const cfg = llmSettings()
  const { parsed, model } = await callOnce(messages, cfg, cfg.temperature)
  return { ...parsed, _model: model }
}

/** 提取一次推演涉及的 board 集合（用于样本差异计算） */
export function boardsOf(result) {
  const set = new Set()
  for (const layer of result?.layers || []) {
    if (Number(layer.level) === 3) {
      for (const name of layer.boards || []) set.add(String(name))
    } else {
      for (const t of layer.targets || []) {
        if (t && t.board) set.add(String(t.board))
      }
    }
  }
  return set
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 样本两两 board 集合的平均 Jaccard 距离：0=完全一致，越大越多样 */
export function diversityScore(results) {
  const sets = results.map(boardsOf)
  if (sets.length < 2) return 0
  let sum = 0
  let n = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      sum += 1 - jaccard(sets[i], sets[j])
      n++
    }
  }
  return Number((sum / n).toFixed(3))
}

function topEntry(map, fallback = '') {
  const list = [...map.entries()].filter(([k]) => k)
  if (!list.length) return fallback
  list.sort((a, b) => b[1] - a[1])
  return list[0][0]
}

function addStat(stats, level, board, direction, logic, criteria) {
  const key = level + '|' + board
  let s = stats.get(key)
  if (!s) {
    s = {
      key, level, board, count: 0, order: stats.size,
      directions: new Map(), logics: new Map(), criteria: new Set(),
    }
    stats.set(key, s)
  }
  s.count++
  if (direction) s.directions.set(direction, (s.directions.get(direction) || 0) + 1)
  if (logic) s.logics.set(logic, (s.logics.get(logic) || 0) + 1)
  for (const c of criteria || []) if (c) s.criteria.add(String(c))
}

/** 多次采样聚合：board 取高频项，方向/理由取众数，confidence 取最小值（保守） */
export function aggregateSamples(results) {
  if (!results.length) return {}
  const stats = new Map()
  for (const r of results) {
    for (const layer of r.layers || []) {
      const level = Number(layer.level) || 0
      if (level === 3) {
        for (const name of layer.boards || []) {
          addStat(stats, level, String(name), '', '', layer.criteria || [])
        }
      } else {
        for (const t of layer.targets || []) {
          if (t && t.board) {
            addStat(stats, level, String(t.board), String(t.direction || ''), String(t.logic || ''), [])
          }
        }
      }
    }
  }

  // 跨层最多 8 个 board、每层最多 4 个，与 prompt 约束保持一致
  const ranked = [...stats.values()].sort((a, b) => b.count - a.count || a.order - b.order)
  const keep = new Set(ranked.slice(0, 8).map((s) => s.key))
  const layerName = (level) => {
    for (const r of results) {
      const l = (r.layers || []).find((x) => Number(x.level) === level)
      if (l && l.name) return l.name
    }
    return level === 3 ? '情绪载体' : level === 2 ? '下游传导' : '直接影响'
  }
  const layers = [1, 2, 3]
    .map((level) => {
      const list = ranked.filter((s) => s.level === level && keep.has(s.key)).slice(0, 4)
      if (level === 3) {
        return {
          level: 3,
          name: layerName(level),
          criteria: [...new Set(list.flatMap((s) => [...s.criteria]))].slice(0, 4),
          boards: list.map((s) => s.board),
        }
      }
      return {
        level,
        name: layerName(level),
        targets: list.map((s) => ({
          board: s.board,
          direction: topEntry(s.directions) || '利好',
          logic: topEntry(s.logics),
        })),
      }
    })
    .filter((l) => (l.level === 3 ? l.boards.length : l.targets.length))

  const falsifierMap = new Map()
  const stocks = new Map()
  const entities = new Set()
  const confidences = []
  for (const r of results) {
    if (r.falsifier) falsifierMap.set(r.falsifier, (falsifierMap.get(r.falsifier) || 0) + 1)
    for (const s of r.mentionedStocks || []) {
      const k = String(s.code || s.name || '').trim()
      if (k && !stocks.has(k)) stocks.set(k, s)
    }
    for (const e of r.event?.entities || []) if (e) entities.add(String(e))
    const c = Number(r.confidence)
    if (Number.isFinite(c)) confidences.push(c)
  }
  const firstEvent = results[0].event || {}
  return {
    event: { ...firstEvent, entities: entities.size ? [...entities] : firstEvent.entities || [] },
    mentionedStocks: [...stocks.values()],
    layers,
    falsifier: topEntry(falsifierMap),
    confidence: confidences.length ? Math.min(...confidences) : 0,
  }
}

/** 同一模型多次采样 + 聚合，附带每次样本摘要与多样性分数 */
export async function reasonEventSampled(messages, options = {}) {
  const cfg = llmSettings()
  const samples = Math.max(1, Number(options.samples) || cfg.samples || 1)
  const temperature = Number.isFinite(options.temperature) ? options.temperature : cfg.temperature
  const raw = []
  for (let i = 0; i < samples; i++) {
    const r = await callOnce(messages, cfg, temperature)
    raw.push({ index: i + 1, model: r.model, result: r.parsed, raw: r.raw })
  }
  return {
    ...aggregateSamples(raw.map((x) => x.result)),
    _model: raw[0].model,
    _samples: raw.map((x) => ({
      index: x.index,
      model: x.model,
      confidence: x.result.confidence,
      boards: [...boardsOf(x.result)],
      falsifier: x.result.falsifier,
    })),
    _diversity: diversityScore(raw.map((x) => x.result)),
  }
}
