// 事件模板：新增事件类型 = 新增一个模板，不改系统架构
export const TEMPLATES = {
  政策管制: {
    keywords: ['出口管制', '制裁', '限制', '禁令', '关税', '补贴', '政策', '监管', '准入', '法案', '管制', '收紧', '豁免'],
    focus: '被限制方直接受损；国产替代/反制受益；谁最可能成为情绪载体',
    layers: [
      { level: 1, name: '直接影响', hint: '消息直接打击或利好的对象，写明方向 +/-' },
      { level: 2, name: '反向/替代受益', hint: '因限制而产生替代、反制、转移需求的一方' },
      { level: 3, name: '情绪载体', hint: '在受益方里，哪类题材最容易被资金选为炒作载体' },
    ],
    falsifierHint: '若政策豁免范围扩大/执行力度低于预期，哪条逻辑削弱',
  },
  产业供需: {
    keywords: ['涨价', '提价', '缺货', '停产', '退出', '减产', '扩产', '供给', '需求', '库存', '价格', '产能', '订单', '断供', '收购'],
    focus: '涨价/短缺直接受益方；下游成本承压方；库存/长约/替代的二阶机会',
    layers: [
      { level: 1, name: '直接影响', hint: '价格变化或供给收缩的直接受益/受损方' },
      { level: 2, name: '下游传导', hint: '成本承压方，以及有库存/长约/替代能力者相对受益' },
      { level: 3, name: '情绪载体', hint: '供给逻辑里最容易被资金炒作的细分环节' },
    ],
    falsifierHint: '若价格回落/供给恢复/需求被证伪，哪条逻辑削弱',
  },
}

export const UNCLASSIFIED = '其他事件'

export function classifyEvent(text) {
  const content = String(text || '')
  let best = null
  for (const [type, tpl] of Object.entries(TEMPLATES)) {
    const score = tpl.keywords.reduce((n, k) => n + (content.includes(k) ? 1 : 0), 0)
    if (!best || score > best.score) best = { type, template: tpl, score }
  }
  if (!best || best.score === 0) return { type: UNCLASSIFIED, template: TEMPLATES.产业供需, score: 0 }
  return best
}

const SYSTEM = `你是 A 股题材推演助手。只做逻辑推演与题材归类，不给买卖建议、不给仓位和价格目标。
严格输出一个 JSON 对象，不要任何解释性文字、不要 markdown 代码块。
输出结构：
{
  "event": {"type": "事件类型", "summary": "一句话概括", "entities": ["关键实体"]},
  "layers": [
    {"level": 1, "name": "直接影响", "targets": [{"board": "板块名", "direction": "利好|利空", "logic": "理由"}]},
    {"level": 2, "name": "反向/替代受益", "targets": [{"board": "板块名", "direction": "利好|利空", "logic": "理由"}]},
    {"level": 3, "name": "情绪载体", "criteria": ["筛选条件"], "boards": ["板块名"]}
  ],
  "falsifier": "逻辑削弱条件",
  "confidence": 0.0到1.0
}
硬性约束：
1. board 字段必须逐字取自「可选板块列表」，禁止自造板块名、禁止输出股票代码。
2. 每一层最多 4 个 board，总数为 3-8 个。
3. logic 用中文，一句话，不超过 40 字。
4. 不确定时降低 confidence，不要编造。`

export function buildMessages(event, boardNames, classified) {
  const tpl = classified.template
  const layerText = tpl.layers
    .map((l) => `  第${l.level}层【${l.name}】：${l.hint}`)
    .join('\n')
  const user = [
    `消息类型：${classified.type}${classified.score ? `（关键词命中 ${classified.score}）` : '（未命中模板，按产业供需框架推演）'}`,
    `消息原文：${event.title || event.content}`,
    event.content && event.content !== event.title ? `补充说明：${event.content.slice(0, 500)}` : '',
    '',
    `请按以下推演重点展开：${tpl.focus}`,
    layerText,
    `反事实检查：${tpl.falsifierHint}`,
    '',
    `可选板块列表（board 字段只能从中逐字选取）：`,
    boardNames.join('、'),
  ].filter(Boolean).join('\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ]
}
