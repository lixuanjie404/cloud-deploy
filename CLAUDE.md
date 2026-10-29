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
npm run dev      # 启动 wrangler 开发服务器
npm run deploy   # 部署到 Cloudflare Workers

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

启用方式：

```bash
# 1. 创建 Hyperdrive（把连接串换成真实值）
npx wrangler hyperdrive create stock-mysql --connection-string="mysql://user:pass@host:3306/db"

# 2. 把返回的 id 填到 wrangler.jsonc 的 hyperdrive 段（已预留注释模板）

# 3. 本地调试先用 .dev.vars（参考 .dev.vars.example）
cp .dev.vars.example .dev.vars
npm run dev
```

安全约束：只允许 GET；表名/列名做标识符校验且必须是库中存在的；`DB_TABLES` 白名单可选但建议开启；不支持任意 SQL 透传。

### 今日进度 · 量能图

原来内嵌的 `https://www.duanxianxia.cn/web/amount` 依赖腾讯分时接口 `web.ifzq.gtimg.cn`，该接口现在返回 501 + WAF 跳转页，导致图表空白。现改为内嵌同源的 `/amount`（`workers/stock/amount.html`），数据走 `GET /api/intraday/amount`，由 Worker 代理东方财富分时接口（`push2.eastmoney.com`），并带一次重试。

**口径：沪深两市合计**（`1.000001` 上证 + `0.399001` 深证，按分钟对齐求和）。单市口径会少掉一半左右（上证 2026-10-27 全天仅 6427 亿，而两市合计 14609 亿），曾因此被用户指出数据不对。

图上是两市当日累计成交额曲线，虚线是上一交易日全天成交额（两市之和）；顶部三个数字为今日累计 / 昨日全天 / 按当前进度折算的预测值。

### 已切回：duanxianxia 量能页（2026-10-29）

- `https://www.duanxianxia.cn/web/amount` 依赖的腾讯分时接口（`web.ifzq.gtimg.cn`）在 2026-10-22 曾返回 501 + WAF 跳转页，导致图表空白；2026-10-29 复测已恢复 200，**已把 iframe 切回原版**。
- 它的优点：今日量能 / 预测量能 / 昨日量能对照（用户偏好其呈现方式）。
- 备用方案保留：`/amount`（`workers/stock/amount.html`，东方财富源）与 `GET /api/intraday/amount` 未删除；再遇 WAF 拦截时把 iframe src 改回 `/amount?theme=<dark|light>` 即可。恢复自检：`curl -s -o NUL -w "%{http_code}" "https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=&code=sh000001&r=0.1"`，200 即可用。

### 600127 量价窗口（单入口试用）

`workers/stock/index.html` 的「运行指标」面板里有一个「600127 量价」按钮，点开是 layer 弹窗，内嵌 ECharts 蜡烛图 + 成交量 + MA5/MA10，数据来自 `GET /api/kline/600127?days=120&adjust=raw`（120 根日线）。

默认用 `raw` 口径：排查发现 `hfq` 在 2026-10-19、2026-10-21 两天的复权比例异常（常态约 5.732，这两天为 4.215 / 3.876），`raw` 序列连续。这两天的成交量也比前后低两个数量级，属数据源自身的待修问题。

前置条件与限制（按官方文档校对于 2026-10）：

- Hyperdrive 只能连**公网 IP**（错误 2009）；本机/内网库需走 Workers VPC 或 Tunnel + Access。
- Hyperdrive **强制对源库使用 TLS**（错误 2012）；MySQL 支持 REQUIRED / VERIFY_CA / VERIFY_IDENTITY，不支持 DISABLED。
- `mysql2` 需 ≥ 3.13.0，且必须 `disableEval: true`（Workers 无 eval，结果超过 100 列时 mysql2 会走 eval 解析）。
- 源库侧连接数：每个 Hyperdrive 配置约 20（Free）/ 100（Paid），池最小 5；Worker 到 Hyperdrive 的并发连接不设限。
- 查询缓存默认开启：`max_age` 60s、`stale_while_revalidate` 15s，最长可调到 1h。
- 本地开发：`wrangler dev` 读 `localConnectionString`，或用环境变量 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 覆盖（优先级更高）；`wrangler dev --remote` 不使用它。
- 直连回退（`DB_*`）仅供本地调试，当前**不校验证书**；生产请走 Hyperdrive。

## 配置

- **`wrangler.jsonc`**: Cloudflare Workers 配置 — 使用 `workers/index.js` 作为入口，静态资源来自 `workers/stock/`，启用 Node.js 兼容性

## 代码规范

### JavaScript
- **不使用 `var`**，优先使用 `let` 和 `const`
- **优先使用 jQuery 选择元素**，如 `$('#id')`、$('.class')` 而非 `document.querySelector`
