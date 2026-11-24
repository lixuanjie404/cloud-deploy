/**
 * 事件模板与 prompt 构造（从 catalyst/templates.mjs 平移，纯逻辑）
 * 新增事件类型 = 新增模板，不改系统架构。
 */
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
  "mentionedStocks": [
    {"name": "A股证券简称（还原后的完整名称，不确定就照抄 raw）", "raw": "原文中的简称/拼音缩写/全称，逐字照抄", "code": "6位代码（仅原文明确给出时填，否则留空）", "context": "原文中提及此股的简短描述"}
  ],
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
4. 不确定时降低 confidence，不要编造。
5. mentionedStocks 只提取原文提及的 A 股上市公司，含简称/别名/拼音缩写。raw 逐字照抄原文写法（如"三花"、"nbhx"、"浙江荣泰"）；name 尽量还原为完整证券简称（如"三花"→"三花智控"、"nbhx"→"宁波华翔"），不确定就照抄 raw。必须排除：非 A 股公司（美股/港股如特斯拉、小鹏）、未上市公司（如字节跳动）、模型/产品/技术名（如 GPT、FSD、Optimus、世界模型）、人名。不要从板块推演补充，不要编造；原文未提及则给空数组。code 仅在原文明确给出 6 位代码时填写，严禁凭记忆猜测或编造代码，否则留空。最多 40 个。
6. 若上下文附带联网检索资料，只能据此推演，仍严格输出上述 JSON；禁止输出引用标记（如 [来源:ref_1]）、来源清单或解释性文字。`

/** 东财板块列表拉取失败时的兜底题材名（仅作 LLM 选项，无 code 则不映射标的） */
export const FALLBACK_BOARDS = [
  '半导体', '芯片', '国产替代', '人工智能', '算力', 'AI芯片', 'GPU', '光刻机', '存储的芯片',
  '信创', '软件', '消费电子', '通信', '5G', '新能源', '光伏', '储能', '锂电池', '汽车',
  '医药', '创新药', '军工', '化工', '有色', '钢铁', '煤炭', '石油', '房地产', '食品饮料',
  '农业', '旅游', '传媒', '游戏', '教育', '零售', '家电', '纺织', '机器人', '低空经济',
].map((name) => ({ code: '', name }))

export function buildMessages(event, boardNames, classified) {
  const tpl = classified.template
  const layerText = tpl.layers
    .map((l) => `  第${l.level}层【${l.name}】：${l.hint}`)
    .join('\n')
  const user = [
    `消息类型：${classified.type}${classified.score ? `（关键词命中 ${classified.score}）` : '（未命中模板，按产业供需框架推演）'}`,
    `消息原文：${event.title || event.content}`,
    event.content && event.content !== event.title ? `消息全文：${event.content.slice(0, 4000)}` : '',
    '',
    `请按以下推演重点展开：${tpl.focus}`,
    layerText,
    `反事实检查：${tpl.falsifierHint}`,
    `请单独列出消息原文中明确提到的 A 股上市公司（raw 逐字照抄原文简称/拼音缩写，name 还原完整证券简称；排除非 A 股公司、未上市公司、模型/产品名、人名；code 仅原文明确给出时填），最多 40 个；原文没有就给空数组。`,
    '',
    `可选板块列表（board 字段只能从中逐字选取）：`,
    boardNames.join('、'),
  ].filter(Boolean).join('\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ]
}
