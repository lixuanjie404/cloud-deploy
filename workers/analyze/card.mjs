/**
 * 催化卡片渲染（从 catalyst/card.mjs 平移，纯逻辑）
 */
export function renderCard({ event, result, candidates, date }) {
  const ev = result.event || {}
  const layers = result.layers || []
  const layerText = layers.map((l) => {
    const targets = (l.targets || []).map((t) => `- ${t.board}（${t.direction}）：${t.logic}`).join('\n    ')
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
  return [
    '【催化卡】' + (ev.summary || event.title || '未命名事件'),
    `类型：${ev.type || '未知'} ｜ 时间：${date} ｜ 置信度：${confidence}`,
    `来源：${event.source || '未知'}${event.url ? ` ｜ ${event.url}` : ''}`,
    '',
    '推演链：',
    layerText,
    '',
    '文中提到的公司：',
    stockText,
    '',
    `逻辑削弱条件：${result.falsifier || '未给出'}`,
    '',
    '候选标的（按确认状态排序）：',
    pickText,
    '',
    '> 仅为题材逻辑推演与关注清单，非买卖建议；请自行核实并注意风险。',
  ].join('\n')
}
