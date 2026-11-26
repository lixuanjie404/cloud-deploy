/**
 * 催化卡片渲染（从 catalyst/card.mjs 平移，纯逻辑）
 */
export function renderCard({ event, result, candidates, carrierAnalysis, sourceLegend, date }) {
  const ev = result.event || {}
  const layers = result.layers || []
  const layerText = layers.map((l) => {
    const targets = (l.targets || []).map((t) =>
      `- ${t.board}（${t.direction}）：${t.logic}${t.onlineSignal ? ' ｜ 网络呼应：' + t.onlineSignal : ''}`).join('\n    ')
    if (l.level === 3) {
      const boards = (l.boards || []).join('、')
      const criteria = (l.criteria || []).join('；')
      return `  ${l.level}. ${l.name}：${boards}\n     载体标准：${criteria}`
    }
    return `  ${l.level}. ${l.name}：\n    ${targets || '- 无明确标的'}`
  }).join('\n')
  const pickText = candidates.length
    ? candidates.slice(0, 8).map((s) =>
      `  - ${s.name}(${s.code}) · ${s.board} · ${s.status} · ${s.reason} · 涨幅${s.chg}%`).join('\n')
    : '  - 暂无满足条件的标的（或接口未返回）'
  const stocks = result.mentionedStocks || []
  const stockText = stocks.length
    ? stocks.map((s) =>
      `  - ${s.name}${s.code ? '(' + s.code + ')' : ''}${s.context ? '：' + s.context : ''}`).join('\n')
    : '  - 原文未明确提及公司'
  const confidence = typeof result.confidence === 'number' ? result.confidence.toFixed(2) : 'n/a'
  // 网络情绪块（轮 A）：无数据时不占行
  const s = result.sentiment || null
  const sentimentText = s && (s.heatLevel != null || s.bias || s.momentum)
    ? [
        '网络情绪：' + [
          s.heatLevel != null ? '热度 ' + s.heatLevel : '',
          s.bias ? '倾向 ' + s.bias : '',
          s.momentum || '',
        ].filter(Boolean).join(' ｜'),
        (s.keyPosts || []).length ? '  · 话题：' + s.keyPosts.slice(0, 5).join('、') : '',
        s.evidence ? '  · 依据：' + s.evidence : '',
      ].filter(Boolean).join('\n')
    : ''
  // 载体共振块（轮 B）：无数据时不占行
  const carriers = Array.isArray(carrierAnalysis) ? carrierAnalysis : []
  const carrierText = carriers.length
    ? '载体共振（与网络热点）：\n' + carriers.map((c) =>
        `  - ${c.target} — 共振 ${c.resonance != null ? c.resonance : '--'}（${c.stage || '--'}）` +
        `${(c.matchedTopics || []).length ? ' ｜ 话题：' + c.matchedTopics.join('、') : ''}` +
        `${c.risk ? ' ｜ 风险：' + c.risk : ''}`).join('\n')
    : ''
  // 来源角标图例：与响应内 [H]/[T]/[P]/[W#] 对应
  const legend = Array.isArray(sourceLegend) ? sourceLegend : []
  const legendText = legend.length
    ? '来源角标：' + legend.map((s) => `[${s.ref}] ${s.label}`).join(' ｜ ')
    : ''
  return [
    '【催化卡】' + (ev.summary || event.title || '未命名事件'),
    `类型：${ev.type || '未知'} ｜ 时间：${date} ｜ 置信度：${confidence}`,
    `来源：${event.source || '未知'}${event.url ? ` ｜ ${event.url}` : ''}`,
    '',
    '推演链：',
    layerText,
    '',
    sentimentText,
    '',
    '文中提到的公司：',
    stockText,
    '',
    `逻辑削弱条件：${result.falsifier || '未给出'}`,
    '',
    '候选标的（按确认状态排序）：',
    pickText,
    '',
    carrierText,
    '',
    legendText,
    '',
    '> 仅为题材逻辑推演与关注清单，非买卖建议；请自行核实并注意风险。',
  ].filter((x) => x !== '').join('\n')
}
