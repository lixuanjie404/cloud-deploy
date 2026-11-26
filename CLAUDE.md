# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本项目中提供操作指南。

## 项目概述

这是一个 **Cloudflare Workers** 项目，支持两种部署方式：
- **Cloudflare Workers**（生产环境）：`workers/index.js`

项目提供股票交易相关的静态 HTML 页面，并将 API 请求代理到后端 `duanxianxia.cn`。

## 网站定位与风格

**核心定位**：程序员上班时查看股票信息的工具，**表面伪装成技术文档/工作台**，避免被他人一眼看出是股票网站

### 🚫 UI 文字暴露规则（两档）

按“是否会被无操作看到”分两档，不再一刀切禁用。

**第一档：任何位置都禁止**

| 禁止字 | 原因 |
|--------|------|
| 股 / 股票 | 直接暴露股票属性 |
| 交易 | 暴露交易属性 |
| 盯盘 | 明显交易术语 |
| 选股 | 暴露选股行为 |
| 两融 | 融资融券术语 |
| 龙虎 | 龙虎榜术语 |
| 盘前 / 盘中 / 尾盘 / 盘后 | 交易时段术语 |

**第二档：仅限“交互后才可见”的位置（涨停 / 跌停 / 复盘 / 竞价 / 连板 属此档）**

- 允许出现：`#toolPanel` 工具集菜单、`layer` 弹窗标题与内容、时间轴 popover、快捷键帮助，以及需点击或下钻才能进入的页面（`qxlive.html`、`yidong.html` 等）。
- 禁止出现：打开首页、不做任何操作就能看到的文本——顶栏与品牌区、`hero-card`、`panel` 的标题与说明、时间轴列头与节点标签、页脚。
- 判定标准：**直接打开 `index.html`、不做任何操作就能看到即违规**；收进菜单/弹窗/popover 后展示，视为合规。
- 其他页面（`qxlive.html`、`yidong.html` 等下钻页）不受此限，打开即显示第二档字样属正常。

**替代原则**：默认视图用工作台语境，如“归档”替代“复盘”、“日志”替代“盯盘”、“早上/中午/下午/晚上”替代“盘前/盘中/尾盘/盘后”。

修改 UI 文字后必须验证两条：
1. 首屏可见文本（`index.html` 的 `.topbar`、`.hero-card`、`.panel` 标题与说明、`.timeline-head`、`.timeline-label`）对第二档字样零命中；
2. 第一档字样全站零命中。

第二档字样若新增，必须同时确认它落在允许位置内（菜单 / 弹窗 / popover / 下钻页），否则改文案或下沉到交互层。

### 校验脚本

```bash
python scripts/check-ui-text.py            # 日常校验，退出码 0 通过 / 1 违规
python scripts/check-ui-text.py --verbose  # 额外打印第二档命中分布（菜单/弹窗/popover/脚本各多少处）
```

脚本固定检查四项：

1. `index.html` 首屏可见区域（顶栏 / `hero-card` / `panel` 标题与说明 / 时间轴列头与节点）对第二档字样零命中；
2. `index.html` 其余位置出现的第二档字样，必须落在 `#toolPanel` 工具集菜单、时间轴 popover 或 `<script>` 弹窗配置内；
3. 第一档字样全站（`workers/stock` 下 html/js/css）零命中；
4. 其他页面（下钻页）不计入违规，仅在报告中统计；规则只约束 `index.html` 直接打开时的可见文本。

改完 UI 文字先跑这个脚本，再提交。

## 命令

```bash
# Cloudflare Workers 开发（默认）
npm run dev      # 启动 wrangler 开发服务器（单端口 8787，含全部催化推演功能）
npm run deploy   # 部署到 Cloudflare Workers（单端口/域名）
npm run sync:dingtalk -- --days 7  # 手动同步钉钉群消息落库（本机 dws CLI，幂等）

```

> 本机直连 `*.workers.dev` 会被解析到不可达的 IP，验证线上接口前先设代理：
> `$env:HTTP_PROXY="http://127.0.0.1:10999"; $env:HTTPS_PROXY="http://127.0.0.1:10999"`
> （仅在当前 PowerShell 会话生效；浏览器访问线上站点不受影响）

## 架构

### 入口文件
- **`workers/index.js`**: Cloudflare Workers 请求处理器 — 将 `/api/*` 请求代理到 `duanxianxia.cn` 后端，包含 30 分钟缓存

### 静态资源
- **`workers/stock/`**: 用于 Cloudflare Workers 部署的 HTML 和 JS 文件

### 路由逻辑（workers/index.js）
- `/message` → 返回 "Hello, World!"
- `/random` 或 `/uuid` → 返回随机 UUID（可设置调试器断点）
- `/api/db/*` → MySQL 只读接口（见下），命中后不进入代理
- `/api/*` → 代理到 `https://duanxianxia.cn/api/*`，使用 30 分钟缓存
- 其他路由 → 404

### MySQL 只读接口（workers/db.js）

连接优先级：`env.HYPERDRIVE` 绑定 > `env.DB_*` 直连参数。

| 接口 | 说明 |
|------|------|
| `GET /api/db/health` | 连通性自检，返回 `VERSION()` / `DATABASE()` / 服务器时间 |
| `GET /api/db/tables` | 列出库中可读表；设了 `DB_TABLES` 时只返回白名单内的表 |
| `GET /api/db/table/:name` | 读表数据，支持 `limit`（≤500，默认 50）/ `offset` / `order` / `dir` / `fields` |
| `GET /api/kline/:code` | 个股日线（默认 120 根），支持 `days`（10-300）/ `adjust`（raw 或 hfq）；仅 index 页「600127 量价」按钮使用，未全站铺开 |
| `GET /api/intraday/amount` | 分时量能（默认 `code=sh000001`），返回当日累计成交额与上一交易日全天成交额；供 `/amount` 页面使用 |
| `GET /api/intraday/stock/:code` | 指定代码的分时走势，含 09:15-09:25 集合竞价虚拟撮合点；`?days=2-5` 连续多日分时（走 push2his，无竞价段，响应 `days` 回填逐日昨收）；供走势详情弹窗使用 |
| `GET /api/suggest?q=` | 标的检索（拼音首字母/全拼/中文/代码前缀），数据源东财 suggest，仅返回 A 股；供走势弹窗按名称首字母选标的 |

启用方式：

```bash
# 1. 创建 Hyperdrive（把连接串换成真实值）
npx wrangler hyperdrive create stock-mysql --connection-string="mysql://user:pass@host:3306/db"

# 2. 把返回的 id 填到 wrangler.jsonc 的 hyperdrive 段（已预留注释模板）

# 3. 本地配置：从 config.example.json 拷到项目上一层，重命名 cloud-deploy.config.json 并填值
#    （见 README「一、在新机器上运行」）
npm run dev
```

安全约束：只允许 GET；表名/列名做标识符校验且必须是库中存在的；`DB_TABLES` 白名单可选但建议开启；不支持任意 SQL 透传。

### 日线表 daily_bar 与后台补全（workers/backfill.js）

- 辨识度候选池 `/api/feat/candidates` 的 20日收益 / 独立性等 K 线因子**只读 `daily_bar` 表**，不在请求里同步现拉。表内只有约 40 只 watchlist/催化标的 + 8 个指数，候选池票几乎都不在表里。
- 读完表后把缺口交给 `backfill.js` 在 `ctx.waitUntil` 里后台补全，响应不阻塞：**缺失**（无数据或不足 81 根）→ 全量拉取落表；**过期**（最新日 < 表内最晚日）→ 只补尾部分（含最新日重写，刷新盘中变动）。成功后冷却 10 分钟，失败 30 秒后可重试；并发 6、总预算 25 秒。
- 待补全时响应 `pending > 0`、`Cache-Control` 缩到 15s 且**不走 stale 复用**，补全完成后下一次请求立即重算出值。前端显示 `--` 即表示正在补全。
- 独立性按标的最后日期对齐基准（`factors.independence`），基准过期覆盖不到时返回 `null`，不会用错位的两段相减。
- 写入口径必须与读一致：指数落表 code 是 `indexDbCode()` → `idx_sh000300`（2026-11-25 修了 cron 写成 `000300` 导致指数停在 10-16 的 bug）。
- 本机 wrangler（workerd）到 `push2his` 常被 `Network connection lost` 断连，node 直连正常；本地验证补全链路可在 `.tmp` 下用 node 脚本直接调 `runBarFill(env, missing, stale)`，`env` 用 `DB_*`。

### 催化推演 · 联网情绪分析（function calls，2026-11-25 实施）

设计与实现细节见根目录《催化推演-联网情绪分析-设计.md》。链路：

1. **预取情绪包**（`tools.mjs prefetchSentiment`，并行、失败不阻塞）：hot_stock 四源聚合 + 涨停原因/板块涨幅聚合，拼成 hotText/topicsText 注入轮 A user。
2. **轮 A**（推演 + 消息网络情绪）：`chatWithTools` 按 OpenAI 兼容 tools 协议循环；**首轮 tool_choice=required 强制至少一次工具调用**（防弱模型跳过工具直接编造；通道不支持 required 时自动退回 auto，不支持 tools 时去 tools 退化纯推演）。输出在原 schema 上增 sentiment 块（heatLevel/bias/momentum/keyPosts/evidence）与层内 onlineSignal。
3. **轮 B**（情绪载体×热门话题共振）：映射确认后用 `buildCarrierMessages` 二次会话，输出 carrierAnalysis[]（resonance/stage/matchedTopics/risk）；独立降级，失败给空数组。
4. 展示：card.mjs 与弹窗 renderCatDetail 各增“网络情绪/载体共振”区块；无数据不占行。

工具（`workers/analyze/tools.mjs`）：get_hot_stocks（hot_stock 多源聚合，5min 缓存）、get_stock_heat（人气排名+连板/炸板）、get_hot_topics（涨停原因计数+概念板块涨幅榜，fetchConceptBoards 已补 changePct 字段）、search_web（联网搜索，默认未配置不暴露，配置 SEARCH_PROVIDER/SEARCH_API_KEY 后启用）。硬性纪律：sentiment 无数据时整块 null 禁止编造；网络情绪只调整 confidence 与提示风险，禁止改变 layers 方向（templates.mjs 约束 7）。

已修 bug：chatWithTools 的 giveTools 曾写成布尔表达式，导致 tools 参数丢失、模型静默降级并编造结果（2026-11-25）。

**来源角标（2026-11-25）**：网络/站内数据支撑的结论必须带角标 —— 工具结果返回 `ref`/`label`（H=人气榜、T=题材热度、P=标的热度、W#=网络检索条目），SYSTEM/guidance/CARRIER_SYSTEM 强制 evidence/onlineSignal/keyPosts 句尾带角标、禁止自造编号；`index.mjs` 用 onTool 收集 ref→label 为 `sourceLegend`，card 末尾与弹窗底部渲染图例，弹窗里 `[H]` 等由 `withRefs()` 转成可悬浮的 `.cat-ref` 上标（title=来源说明）。

**模型优先级链（2026-11-25）**：服务端默认链在 `.dev.vars`（线上用 secret）`LLM_PROVIDERS`：移动云 `glm-5.3`（`moma.cmecloud.cn/v1`，推理模型，extraBody max_tokens=16384）→ 智谱 `glm-4-flash`/`glm-4.5-flash` → OpenRouter。**浏览器入口**：催化推演弹窗「模型」按钮，优先级列表存 localStorage（`cat_llm_providers_v1`），随 POST body `providers` 下发；`normalizeProviders(env, browser)` 合并规则 = 浏览器条目在前（base/key/models 缺一即跳过，最多 6 条，不收 extraBody）、服务端链兑底；任一通道失败自动切下一个。注意：移动云账号可用模型名是 `glm-5.3`（curl 里的 `zhipu/glm-5.3` 会 402 subscription_required）；glm-5.3 支持 function calling 与 `tool_choice=required`（已实测）。

### 今日进度 · 量能图

原来内嵌的 `https://www.duanxianxia.cn/web/amount` 依赖腾讯分时接口 `web.ifzq.gtimg.cn`，该接口现在返回 501 + WAF 跳转页，导致图表空白。现改为内嵌同源的 `/amount`（`workers/stock/amount.html`），数据走 `GET /api/intraday/amount`，由 Worker 代理东方财富分时接口（`push2.eastmoney.com`），并带一次重试。

**口径：沪深两市合计**（`1.000001` 上证 + `0.399001` 深证，按分钟对齐求和）。单市口径会少掉一半左右（上证 2026-10-27 全天仅 6427 亿，而两市合计 14609 亿），曾因此被用户指出数据不对。

图上是两市当日累计成交额曲线，虚线是上一交易日全天成交额（两市之和）；顶部三个数字为今日累计 / 昨日全天 / 按当前进度折算的预测值。

### 已切回：duanxianxia 量能页（2026-10-29）

- `https://www.duanxianxia.cn/web/amount` 依赖的腾讯分时接口（`web.ifzq.gtimg.cn`）在 2026-10-22 曾返回 501 + WAF 跳转页，导致图表空白；2026-10-29 复测已恢复 200，**已把 iframe 切回原版**。
- 它的优点：今日量能 / 预测量能 / 昨日量能对照（用户偏好其呈现方式）。
- 备用方案保留：`/amount`（`workers/stock/amount.html`，东方财富源）与 `GET /api/intraday/amount` 未删除；再遇 WAF 拦截时把 iframe src 改回 `/amount?theme=<dark|light>` 即可。恢复自检：`curl -s -o NUL -w "%{http_code}" "https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=&code=sh000001&r=0.1"`，200 即可用。

### 分时 / 日线窗口（含集合竞价）

`workers/stock/index.html` 的走势详情 layer 弹窗入口：资料归档 →「日线回看」（默认日线 tab）；候选池 / AI 分析里的个股代码链接也会打开弹窗（默认分时 tab）。同一弹窗复用：输入支持 6 位代码或名称首字母/中文（走 `GET /api/suggest`，回车取首个匹配、输入时下拉候选；默认 `002242`，用 localStorage 记住上次代码与视图），在「分时·竞价」「5日分时」「日线」三个 tab 间切换，交易时段每 30 秒刷新一次。第二档字样只放在弹窗与支线 popover 内（均为交互后可见位置），运行指标面板不再保留按钮。

- **分时**：`GET /api/intraday/stock/:code`，上游是东方财富 `trends2/get`，**必须带 `iscr=1`**，否则只有 09:30 之后的连续竞价。带上后 09:15-09:25 共 11 个竞价虚拟撮合点（成交量为 0、均价锚在昨收），09:26 那一点带 9:25 的撮合成交量，09:27-09:30 是无成交占位点，09:31 起进入连续竞价。接口按时间给点打 `auction` 标记并返回 `auctionEnd`，前端据此画竞价区背景、在竞价段断开均价线，竞价点的 tooltip 不显示成交量。
- **5日分时**：`GET /api/intraday/stock/:code?days=5`（days 1-5，默认 1）。ndays>1 必须走 `push2his` 域名（push2 无论 ndays 都只回当日）；上游多日不含竞价段（含当日），每天 09:30-15:00 首尾相接；响应 `days` 字段用日线收盘回填逐日昨收，前端据此按日着色成交量、画日界虚线。
- **日线**：`GET /api/kline/:code?days=120&adjust=raw`，ECharts 蜡烛图 + 成交量 + MA5/MA10；MySQL 无该代码时回退东方财富日线，回退响应同样带 `latest`。

默认用 `raw` 口径：排查发现 `hfq` 在 2026-10-19、2026-10-21 两天的复权比例异常（常态约 5.732，这两天为 4.215 / 3.876），`raw` 序列连续。这两天的成交量也比前后低两个数量级，属数据源自身的待修问题。

前置条件与限制（按官方文档校对于 2026-10）：

- Hyperdrive 只能连**公网 IP**（错误 2009）；本机/内网库需走 Workers VPC 或 Tunnel + Access。
- Hyperdrive **强制对源库使用 TLS**（错误 2012）；MySQL 支持 REQUIRED / VERIFY_CA / VERIFY_IDENTITY，不支持 DISABLED。
- `mysql2` 需 ≥ 3.13.0，且必须 `disableEval: true`（Workers 无 eval，结果超过 100 列时 mysql2 会走 eval 解析）。
- 源库侧连接数：每个 Hyperdrive 配置约 20（Free）/ 100（Paid），池最小 5；Worker 到 Hyperdrive 的并发连接不设限。
- 查询缓存默认开启：`max_age` 60s、`stale_while_revalidate` 15s，最长可调到 1h。
- 本地开发：实测 wrangler 4.20.5 在未配 `localConnectionString` 时 `wrangler dev` 会直接报错退出；需设环境变量 `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`（旧文档写的 `CLOUDFLARE_` 前缀在本版本不生效），或在 `wrangler.jsonc` 的 hyperdrive 段补 `localConnectionString`。报错文案写 "Postgres" 是 wrangler 的通用模板，本项目用 `mysql://` 即可（miniflare 同时支持 postgres 与 mysql），不必装 Postgres。该变量由 wrangler 进程从 shell / `.env` 读取，写进 `.dev.vars` 无效。`npm run dev` / `npm start` 已改为 `scripts/wrangler-dev.mjs`，它从 `.dev.vars` 的 `MYSQL_*`（或 `DB_*`）自动拼连接串注入，无需手工设置、也不会把口令写进受版本控制的文件；直接跑 `npx wrangler dev` 仍需自己设变量。本机 `curl 127.0.0.1:8787` 需加 `--noproxy '*'`，否则请求会被系统代理拦走。`wrangler dev --remote` 不使用它。
- 直连回退（`DB_*`）仅供本地调试，当前**不校验证书**；生产请走 Hyperdrive。

## 配置

- **统一配置文件**：项目上一层的 `cloud-deploy.config.json`（模板 `config.example.json`）。专案不再直接引用 ai-stock / ai+stock 的项目文件。`scripts/config.mjs` 是唯一加载器，优先级：环境变量 > 配置文件 > 默认值。新机器运行 = 拉取项目 + 拷配置文件到上一层。详见 README。
- **`wrangler.jsonc`**: Cloudflare Workers 配置 — 使用 `workers/index.js` 作为入口，静态资源来自 `workers/stock/`，启用 Node.js 兼容性。核心展示功能纯 fetch 东财、部署即用；`hyperdrive` id 换账号时需改。

## 代码规范

### JavaScript
- **不使用 `var`**，优先使用 `let` 和 `const`
- **优先使用 jQuery 选择元素**，如 `$('#id')`、$('.class')` 而非 `document.querySelector`
