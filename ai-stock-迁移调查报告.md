# ai-stock → cloud-deploy 功能兼容迁移调查报告

- 调查日期：2026-11-17
- 性质：**只读调查，未修改任何代码**。全部结论来自本机文件读取（Windows，PowerShell），无外部网络数据查询。
- 源仓库：`C:\Users\admin\lxj\ai-stock`（下称 ai-stock）；目标仓库：`C:\Users\admin\lxj\cloud-deploy`（下称 cloud-deploy，当前工作区）。
- 目的：为「把 ai-stock 的功能兼容迁移到 cloud-deploy」的事实决策提供依据；本文只列事实与已成立的连接，**不做方案决策**。

---

## 0. 结论速览

1. 两项目已通过两条通道连接：① ai-stock 的灌库脚本把行情/元数据写进共享 MySQL，cloud-deploy 的 `/api/kline`、`/api/intraday/stock`（名称回查）、`/api/db/table/*` 直接读这张库；② cloud-deploy 首页「资源」卡外链 ai-stock 的 Render 部署 `https://ai-stock.onrender.com`（index.html:1380）。
2. cloud-deploy 是 Cloudflare Workers（JS）+ 静态 HTML + /api 代理（duanxianxia.cn）+ Hyperdrive MySQL 只读；**Workers 无 Python 运行时**，ai-stock 的 akshare/pandas/streamlit 代码不能原样搬运（nodejs_compat 只兼容 Node API）。
3. ai-stock 实际是 **8 个页面**（导航实测：行情/回测/信号/核心股/KPL人气榜/AI分析/AI趋势/设置）；自述文档（CODEBUDDY.md、architecture.md）仍写 7 页，KPL 人气榜是文档滞后的新增。
4. cloud-deploy 已有与 ai-stock 重叠的能力仅限：个股分时（含集合竞价）/个股日线 K 线（echarts，东财回退）/沪深两市量能/若干外链资讯页；ai-stock 的信号、回测、核心股、热门聚合、AI 分析、推送、设置等业务页在目标侧完全没有。
5. cloud-deploy 有 ai-stock 没有的强约束：UI 伪装文案规则（两档禁词 + `scripts/check-ui-text.py` 校验，首屏禁现「涨停/龙虎/盯盘」类词）；迁移任何 UI 文案必须过这道闸。
6. 钉钉群消息：ai-stock 已把快照灌进 MySQL `dingtalk_message` 表供线上读（SQL 时间窗+匹配词下推，60s 缓存）；cloud-deploy 侧没有任何 dingtalk 相关接口（workers/ 全 grep 零命中），通用表浏览 `/api/db/table` 无 WHERE 下推、limit≤500，承载不了该查询模式。
7. 凭据治理现状：ai-stock 的 `config.json`（含 LLM/邮箱/ima/新华 API key 明文）与 `config/.env` **随仓库跟踪**（PRD D8 已登记待治理）；cloud-deploy 口令走 `.dev.vars` / secrets，wrangler.jsonc 不放明文。

---

## 1. 目标环境 cloud-deploy 现状

### 1.1 部署形态与配置

| 项 | 事实 | 出处 |
|---|---|---|
| 运行时 | Cloudflare Workers，`wrangler.jsonc`：name `stock`，main `workers/index.js`，assets `./workers/stock`，compatibility_date 2025-06-20，flags `nodejs_compat` + `global_fetch_strictly_public`，observability 开 | wrangler.jsonc |
| 数据库 | Hyperdrive 绑定 `HYPERDRIVE`（id `b4cf3fc197f64ec380794d378dae75a5`），源库需公网可达 + 强制 TLS；直连回退 `DB_*`/`MYSQL_*` 仅限本地调试且不校验证书 | wrangler.jsonc、CLAUDE.md、workers/db.js |
| 依赖 | `mysql2 ^3.24.6`（须 `disableEval:true`，Workers 无 eval）；wrangler `^4.20.5`；express/http-proxy-middleware/compression 等为 workers2 遗留依赖 | package.json |
| 本地 dev | `npm run dev` → `scripts/wrangler-dev.mjs` 从 `.dev.vars` 的 `MYSQL_*`/`DB_*` 自动拼连接串注入；直接 `npx wrangler dev` 需自设 `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | package.json、.dev.vars.example、CLAUDE.md |
| 备用副本 | `workers2/`（express + http-proxy-middleware 静态 workers2/stock + `/workers` 代理 duanxianxia.cn/api，端口 3000）+ 同套静态页拷贝；非当前部署入口 | workers2/main.js |
| 教学残留 | 根目录 `01.nodejs-http.js`、`02.nodejs-express.js` 为 Node 示例文件 | 工作区根 ls |

### 1.2 Worker 路由与接口（workers/index.js 及三个模块）

路由顺序（index.js）：`/api/db/*` → db.js；`/api/kline/*` → kline.js；`/api/intraday/*` → intraday.js；`/message`、`/random`、`/test`、`/uuid` 固定响应；其余 `/api/*` 前缀 → 代理 `https://duanxianxia.cn`（30 分钟 Cache-Control）；其他 404。

- **通用代理**（index.js）：转发 method/body 到 duanxianxia.cn 后 `response.json()` 再重序列化；注意代码写的是 `headers: request.header`（Request 无该属性，实际等于不带原请求头转发）——迁移涉及代理行为时需知道这一现状。
- **`/api/db/*` 只读表浏览**（db.js）：仅 GET；`/api/db/health`（VERSION/DATABASE/NOW）、`/api/db/tables`、`/api/db/table/:name?limit&offset&order&dir&fields`；`limit≤500`（默认 50）；表/列名过 `^[A-Za-z0-9_$]{1,64}$` 且必须存在于库；`DB_TABLES` 白名单可选；禁止任意 SQL，**无 WHERE 条件能力**；表数据缓存 max-age=30；CORS `*`。
- **`/api/kline/:code?days&adjust`**（kline.js）：6 位代码；`adjust` 仅 `raw|hfq`；`days` 10–300（默认 120）；SQL `SELECT trade_date, open, high, low, close, volume, amount FROM daily_bar WHERE code=? AND adjust=? AND close>0 ORDER BY trade_date DESC LIMIT ?`；**MySQL 无该代码时回退东方财富日线 `push2his`（fqt=0，注释明言与 raw 口径一致）**，回退响应同样带 `latest`；缓存 max-age=60。
- **`/api/intraday/amount`**（intraday.js）：东方财富 `trends2` 上证 `1.000001` + 深证 `0.399001` 按分钟对齐求和（沪深两市合计口径），带一次重试（250ms）与 `cf cacheTtl 20`；昨日全天额取东财日线 `lmt=2`；顶部返回 prevTotal/prevDate/累计曲线。
- **`/api/intraday/stock/:code`**（intraday.js）：`trends2` 带 **`iscr=1`**（否则只有 09:30 后连续竞价），返回 09:15–09:25 竞价虚拟撮合点（`auction` 标记 + `auctionEnd` 下标）、`preClose`、分钟 price/avg/volume；股票名称 best-effort 查 MySQL `stock_list`。

### 1.3 依赖的 MySQL 表（与 ai-stock 灌库 schema 对齐）

Worker 侧实际读到的表：`daily_bar`（`code VARCHAR(16)`, `adjust VARCHAR(3)`, `trade_date DATE`, OHLC/volume/amount DOUBLE, PK `(code, adjust, trade_date)`）与 `stock_list(code, name)`。与 ai-stock `data/store.py` 的 MySQL DDL 同构（store.py:668-694）。库中实际有哪些表、数据量多少，本次未连库核查（见覆盖度）。

### 1.4 Hyperdrive 平台约束（CLAUDE.md 汇总，按官方文档校对于 2026-10）

只连公网 IP（错误 2009）；强制 TLS；mysql2 ≥3.13 且 `disableEval:true`；源库连接池约 20（Free）/100（Paid）、最小 5；查询缓存默认 max_age 60s / stale_while_revalidate 15s，最长 1h；`wrangler dev` 本地需 `localConnectionString` 或环境变量（报错文案写 "Postgres" 是通用模板，MySQL 即可）。

### 1.5 静态页现状（workers/stock/）

| 页面 | 标题/角色 | 关键事实 |
|---|---|---|
| index.html（2439 行） | 「工作台」，伪装技术工作台 | 顶栏：资讯中心外链菜单（东财研报/九阳公社/724快讯/选股通/ima）、实时监控菜单（→yidong/ztlive）、工作流程、开始工作（=打开 news）；hero-card：AI 辅助/政策参考/趋势/资源四组外链卡，其中**「云端服务」→ https://ai-stock.onrender.com**；「今日进度」面板三种视图：无 / 量（iframe `https://www.duanxianxia.cn/web/amount`，2026-10-29 切回原版，备用 `/amount`）/ 880005（东财涨跌家数，数据来自**跨域直连** `duanxianxia.cn/api/getLastQxlive` 与 `/api/getLiveByStrong`）；「工作流程」时间轴 = 外链 popover 集合（金十、东财两融、微博、同花顺热榜、B站、淘股吧、竞价数据 jjlive、问小达、复盘 fupangu、龙头高度、涨停分析 fupan、财报预告、研报中心）；「运行指标」面板：查看指标面板（→/qxlive.html）+「分时走势」按钮 → layer 弹窗，调**同源** `/api/intraday/stock/:code`（分时·竞价 tab）与 `/api/kline/:code?days=…`（日线 tab，echarts 蜡烛+成交量+MA5/MA10，30 秒轮询）；快捷键 1–5/t/d/?；主题切换 localStorage |
| amount.html | 沪深量能 | 同源 `GET /api/intraday/amount` + echarts（CDN jsdelivr 5.5.1，兜底 duanxianxia 静态） |
| news.html | 信息订阅 | 引 duanxianxia.cn 的 bootstrap/jquery/css + 微信 jweixin-1.6.0；含「实时动态」「标签库」面板 |
| qxlive.html | 板块强度 | 指标面板下钻页 |
| yidong.html / ztlive.html | 「状态广播」（菜单名：异动监控 / 实时监控） | ztlive 带「变更通知」与语音开关（`js/web_ztlive.js`、`js/ydbb.js`）；`js/layer.min.js`、`js/need/` 本地件 |
| 公共依赖 | — | jQuery 2.0.0 与 layer 3.5.1 走公网 CDN；echarts 用 duanxianxia.cn 静态文件兜底 |

### 1.6 UI 伪装规则（迁移 UI 必守，CLAUDE.md）

- 第一档（**任何位置禁现**）：股/股票、交易、盯盘、选股、两融、龙虎、盘前/盘中/尾盘/盘后。
- 第二档（仅交互后可见位置可用：`#toolPanel` 菜单、layer 弹窗、时间轴 popover、下钻页）：涨停、跌停、复盘、竞价、连板；首屏（顶栏/hero-card/panel 标题与说明/时间轴列头/页脚）零命中。
- 替代话术：「归档」代「复盘」、「日志」代「盯盘」等；改 UI 文字后必须跑 `python scripts/check-ui-text.py`（退出码 0/1）。

---

## 2. ai-stock 现状（源仓库）

### 2.1 定位与技术栈

- A 股个人量化看板，Streamlit 单进程，只读展示 + 信号提醒，**非实盘系统**（CODEBUDDY.md；docs/gap-analysis.md 自评「玩具级与业余工具级之间」）。
- Python ≥3.10（部署 3.11）；依赖锁定：streamlit 1.64.0 / pandas 2.3.3 / numpy 2.2.6 / plotly 7.1.0 / akshare 1.18.88 / requests / streamlit-searchbox 0.1.24 / PyMySQL 1.2.3（可选，仅 MySQL 后端）（requirements.txt）。
- 入口：`python main.py` = `streamlit run web/app.py`（默认 8501）；start.sh/ps1/bat 走 8502；Dockerfile 暴露 8501 + 容器注入 PORT；已部署 Render（`ai-stock.onrender.com`，cloud-deploy 首页已外链）。容器/Render 内无 dws 连接器（钉钉线上走 MySQL 中转）。
- `web/app.py` 单文件 **3853 行**；无测试框架、无 lint；`tests/` 有 **16 个 `verify_*.py`** 断言脚本（CODEBUDDY.md 列 14 个，kpl_hot/model_profiles*/review/xinhua 为新增）。
- Git 远程：origin=GitCode（主）、github 镜像（.codebuddy/rules/git-remotes.md，2026-11-08 确认）。

### 2.2 页面清单（web/app.py `_TITLES` 实测 8 页，区域注释行号）

| 页面 | 主要内容 |
|---|---|
| 📈 行情（每日看板，2388 行起） | 第一屏「近期热门」（东财人气榜快照 + 涨停池多日聚合「持续热门」）；「热门板块」两种口径 radio（当日横截面 `hot_boards` vs 250 日历史分位 `hot_sectors` 研报口径，默认后者）；K 线（plotly，`attach_indicators` 整段预热 MA/MACD，视窗拖拽/缩放/复位，展示价用 raw）；股票搜索 `streamlit-searchbox`（`ui_state.py` 持久化偏好）；顶部数据质量状态条（`health_view.py`，巡检只报不修） |
| 🧪 回测（2483 行起） | 策略回测（4 内置策略、T+1 次日开盘、佣金万三最低 5 元 + 卖出印花税万五、成交约束开关与 blocked 明细、未来函数审计绿勾/红字、归因 β(沪深300)+行业+残差 α+逐笔 t 值、稳健性面板：参数敏感/样本外 walk-forward/成本压力/分年/红旗）；「隔日超短」模式（`shortline_view.py`，见 2.4） |
| 🔔 信号（2789 行起） | watchlist 策略信号 → HTML 热力表（rowspan 分区 + 色阶）+ AI 融合重排（AI 强化/存疑）+ 可排序明细折叠；信号超 5 天提示失效；「每日策略」块（复制提示词→DeepSeek→粘回解析→汇总操作清单）；主力净额前十（**两套口径**：东财主力净额 / 同花顺净主动买入，`source` 列透传）；推送按钮（邮件 + Server 酱） |
| 🎯 核心股（2292 行起） | `signals/core_candidates.build()`（缓存 5 分钟）：涨停池近 5 日 → 板块档位 S/A/B/C → 1–3 板三因子（容量/时间/封单，全布尔）→ A/B/C + 角色；`next_check` 只用已收盘的下一交易日 |
| 🔥 人气榜（KPL，2901 行起） | 开盘啦盘中/复盘两张人气榜；页面缓存 TTL 1h，快照按（口径，小时）去重落 `data/kpl_hot_history.jsonl`；watchlist 标记 |
| 🤖 AI 分析（2960 行起） | 生成/重生成报告（LLM 六段结构 + 编号引用 [Q]/[N#]/[K#]/[E#]/[I#]/[D#] + 末行 `MACHINE_VERDICT` 解析落盘）；异动核验面板；钉钉材料面板（开关/回溯天数/额外别名/手动同步）；命中率反馈面板；新闻链接列表（`bundle.news_links`）；多模型 profiles 管理 |
| 🛰️ AI 趋势（3283 行起） | 静态研究简报 `web/ai_trends.html` 内联注入 |
| ⚙️ 设置（3315 行起） | watchlist、策略、notify（邮箱/Server酱）、ai 多模型 profiles（`analyzer.with_model_profile` 等专用写法）、ima 知识库、db backend 开关；各节「磁盘最新值为底、只更新自己那段 + 原子写」保存 |

### 2.3 数据层（data/，fetcher.py 836 行为唯一外部源入口）

- **行情**：`get_daily(code)` 优先读缓存（`daily_bar` 单表，PK `code+adjust+trade_date`；指数 `code='idx_sh000300', adjust='idx'`），缺口按段增量补拉（纯函数 `plan_fetch`）；指数接口只支持全量、按交易日判重拉。主源 AkShare（15 处调用）；脏数据防御（前导零 `zfill(6)`、重复行、亿/万/元混单位）已有 `_parse_amount`/`_strip_pct`。
- **新闻四源**（均带 `url` 溯源列，财联社电报无链接留空）：东财新闻、巨潮公告、财联社电报、研报；另有 **新华财经 MCP**（`data/xinhua.py`，streamable-http，12 工具，XHCJ_API_KEY，2026-11-16 实测结论写在模块 docstring）。
- **人气/热榜**：东财人气榜 requests 直连（akshare 封装 RemoteDisconnected）；涨停池 `stock_zt_pool_em`；**KPL 开盘啦** POST `apphq.longhuvip.com`（**硬约束 Dalvik UA**，非官方接口无合同，按位置解析 + 防御）。
- **主力净额**：东财「今日主力净流入-净额」优先，降级同花顺「即时」净主动买入，`source` 列区分，绝不混读。
- **存储**（`data/store.py`）：SQLite/MySQL 双后端，`DATABASE_URL` 环境变量优先 → `config.json db.backend` → 默认 SQLite，降级不阻断；MySQL `daily_bar` utf8mb4/DATE/JSON profile；**对外日期恒 'YYYY-MM-DD' 字符串**；MySQL `ON DUPLICATE KEY UPDATE` 撞任意唯一键的坑（除主键不得加唯一索引）；SQLite 已 WAL + busy_timeout。
- **本地存档**（data/ 实测 ls）：`main_flow_history.jsonl`、`hot_history.jsonl`、`kpl_hot_history.jsonl`、`zt_pool_history.jsonl`、`quality_history.jsonl`、`sector_heat.json`、`ai_feedback.jsonl`、`dingtalk_history.jsonl`（旧单文件）、`dingtalk/`（YYYY-MM.jsonl 月分区）、`dingtalk_sync_state.json`、`ui_history/ui_prefs/ui_session.json`；注：architecture.md 所写 `hot_boards.py → data/board_history.jsonl` 在 ls 中**未出现**（该存档尚未生成）。
- **运行期落点硬约定**：只许写 `data/`、`ai_cache/`、`_tmp/` 三处（`tests/verify_layout.py` 静态检查）；`data/dingtalk/` 月分区是唯一入库例外（脱敏后 git commit、不 push）；根目录 `stock.db`（文档自述约 25MB）可重建、不入库。

### 2.4 策略 / 回测 / 信号（strategy/ backtest/ signals/）

- 策略注册表 `STRATEGIES`：双均线 / MACD / N日突破 / MA20穿越；新策略必须声明 `info_lag`、禁止行情列负向 shift。
- 回测引擎：全仓进出、信号次日开盘成交、佣金万三（最低 5 元）+ 卖出印花税万五；成交约束 `exec.py`（滑点 5bp、涨跌停按 **raw** 判定、停牌按交易日历顺延 ≤5 日、整手、参与率金额口径、除权限价折算）；2026-10 修复轮六项账务不变量（现金不为负、pnl=现金差、整手用未复权价等），金线 `tests/verify_backtest.py` 必须全绿；组合回测 `portfolio.py`（≤2 持仓 + 隔日强平）；可信度边界见 docs/backtest-credibility.md（绩效数字「方向可参考」≠实盘收益）。
- **隔日超短**（docs/shortline.md，v1 2026-10-20）：T 日收盘涨停池 7 个布尔因子（连板 1–2、封单/流通市值 ≥1%、首封 ≤10:00、零炸板、成交额 ≥2 亿、板块效应 ≥2 家、排除 ST/北交所/一字板）→ T+1 开盘买 → hold_days 开盘无条件卖；≤2 持仓，个股仓位 = 市场档位(0/40/70/100%) × 20%；不做加权分，score 仅排序。
- 信号链：`daily.py` watchlist 信号 → `fuse.py` 融合最新 AI 结论（**AI 只强化/标疑、不可翻转**，缺失/过期/失败一律降级纯技术信号）→ UI/推送；`main_flow.py` 全市场主力净额；`plan.py` 每日策略（纯函数）；`review.py` DeepSeek 长文本地解析；`position.py` 涨停家数/炸板率/连板高度 → 4 档总仓位。
- 命中率埋点：`ai_analysis/feedback.py` 融合落盘 → horizon 日收益回补 → by_stance/by_effect/by_confidence 统计（PRD S1 指出 by_confidence 算了未展示、面板全量读取变慢）。

### 2.5 AI 分析链路（ai_analysis/）

- `analyzer.py`：行情摘要 + 多源新闻（带 url）+ ima 知识库片段 + 异动/直接事件 + 间接关联 → 编号引用块 → LLM 六段结构输出，末行 `MACHINE_VERDICT: stance=…; confidence=…; horizon=…` 由 `parse_conclusion()` 解析落盘，供信号页融合；多模型 profiles（config.json `ai.profiles` + `active_profile`）。
- `event_check.py` 异动核验：涨跌停按 `exec.limit_price` + 板块限幅；重复快照 bar/无量 bar 排除；事件分级（公告确认 > 多源报道 > 单一来源），模型只引用不改写。
- `ima_kb.py`：MCP 数字 id 与 OpenAPI base64 `kb_id` 两套体系不可混用；多关键词 AND 检索恒 0 条 → 单词检索 + 本地 MUST 过滤。
- 报告以磁盘缓存为准：`ai_cache/{code}_{start}_{end}.md/.json/.events.json/.dingtalk.json`。
- **钉钉群消息**（data-flow.md 第 5 条）：只绑「每日调研──破晓📈」群；`dws` 是本机 WorkBuddy 连接器 CLI + OAuth 登录态（容器/Render 无）；`sync_if_stale` 120 秒节流 + 按快照最新日期自适应补拉（上限 30 天）；快照按 `createTime` 落月分区 `data/dingtalk/YYYY-MM.jsonl`（写入脱敏）；本地 `sync_recent` 成功后 best-effort 推 MySQL `dingtalk_message` 表（`scripts/sync_dingtalk_to_mysql.py`，INSERT IGNORE、逐 ID 比对）；**线上无 dws 时只读 MySQL**——性能硬约束：全量 711 条 MEDIUMTEXT 实测 125 秒，必须把「时间窗 + 个股匹配词」下推到 SQL（实测 4.6 秒）+ 60 秒进程内缓存；群内转述一律弱证据标「未核实」。数据持续更新靠 WorkBuddy 定时任务每日 10:00 跑 `scripts/run_dingtalk_sync.py --commit`（一次性命令，不 push；退出码 1–4 语义见规则文件）。

### 2.6 推送 / 调度 / 配置 / 部署

- 推送：邮件（smtp.qq.com:465 → 收件 `tencent1@dingtalk.com` 的钉钉邮箱变通路径）+ Server 酱（config 中 enabled:false）；无重试、无留痕、失败仅 print（PRD D6 待办）。
- 调度：看板本体**无调度器**，数据更新依赖打开页面触发（PRD 实测曾 6 天空窗）；仅钉钉同步（WorkBuddy 定时）与 KPL 小时快照（`scripts/kpl_hot_hourly.py`）是脚本化定时。
- 配置：`config.json` 唯一配置文件，**随仓库跟踪且含明文密钥**（实测节：watchlist[600127,000338,688111,002384,000066]、strategy=MA20穿越、notify.email/serverchan、ai(provider/model/api_key/custom_*/ima_* + profiles[p1=zhenze deepseek-v4-flash-0731, active=p1])、xinhua.enabled/api_key；本文不复制任何密钥值）；`config/.env` 同样随仓库跟踪（DATABASE_URL 只走环境变量，绝不入 config.json）——PRD D8 已登记「移出跟踪 + 轮换凭据」为 P0 待办。
- PRD 关键未完成项（迁移相关）：D1 第二数据源对账、D3 财务估值数据（「基本面是一张白纸」）、D4-1 main_flow 读取侧去重、D5 每日自动管道、D6 推送渠道扩展、D7 日志、D8 密钥治理、S1 周报自动化、S2 模拟盘。已实现：D2 数据质量巡检（①②④⑤）、D4-2 SQLite WAL、D4-3 双后端通道。

### 2.7 ai-stock → MySQL 灌库脚本（两库连接的关键事实）

- `scripts/sync_to_mysql.py`：SQLite → MySQL 灌 `daily_bar`（逐序列 upsert）+ 元数据四表 `stock_list/stock_adj/stock_industry/stock_profile`（executemany）；**逐序列比对口径：行数 / MIN(trade_date)–MAX(trade_date) / `ROUND(SUM(close),6)`** 全等才算匹配；报告落 `_tmp/sync_report.md`；需 `DATABASE_URL`。
- `scripts/sync_dingtalk_to_mysql.py`：钉钉消息灌 `dingtalk_message` 独立表（INSERT IGNORE），支持 `--dry-run` 只读探测。
- 结论：cloud-deploy Worker 读的正是这两条脚本灌出的库；`kline.js` 注释明言「MySQL 未同步的代码回退东方财富日线」。

---

## 3. 交叉事实（迁移直接相关）

1. **已成立连接**：①共享 MySQL（ai-stock 灌库 → cloud-deploy 只读三接口）；②首页外链 `ai-stock.onrender.com`。迁移是在这两条既有通道之上扩展。
2. **运行时鸿沟（平台事实）**：Cloudflare Workers 只跑 JS；`nodejs_compat` 兼容 Node API，不提供 Python。ai-stock 的 akshare/pandas/numpy/plotly/streamlit 代码与 `dws` 本机连接器、Windows/WorkBuddy 定时任务均无法在 Workers 内运行；能平移的是「数据形态」（daily_bar/JSONL 口径）与「前端展示」，不能平移的是取数 SDK 与计算进程。
3. **数据源差异**：ai-stock 取数走 AkShare SDK + 裸 requests（东财人气榜、KPL POST 接口需 Dalvik UA、新华 MCP JSON-RPC）；cloud-deploy Worker 侧已实测可行的模式是「直接 fetch 东财 REST（push2/push2his，带 UA/Referer + cf cacheTtl）+ MySQL」。KPL/新华/ima/AKShare 共享封装在 Worker 侧均无现成等价物（本调查未验证这些接口从 Workers 出网的可达性）。
4. **功能覆盖对照**（ai-stock 8 页 vs cloud-deploy 现状）：
   - 已有重叠：个股分时（含竞价）✅、个股日线 ✅（但 ai-stock 版带 MA/MACD/复权切换/视窗缩放/统计卡，cloud-deploy 版是 echarts 蜡烛 + MA5/MA10 + 东财回退）、指数量能 ✅（口径均为沪深两市合计）。
   - 完全没有：信号/回测（含隔日超短）/核心股/近期热门与热门板块两口径/KPL 人气榜/AI 分析与事件核验/命中率/每日策略/推送/设置与多模型管理。
5. **UI 伪装闸**：ai-stock 页面文案大量含「涨停池/龙虎榜/涨跌停/复盘」等第二档词，直接搬 UI 必须改写并落位到允许位置（菜单/弹窗/popover/下钻页），并通过 `scripts/check-ui-text.py`；第一档词（股票/交易等）全站禁现。
6. **钉钉缺口**：`dingtalk_message` 表已在中转库且 ai-stock 线上依赖「时间窗+匹配词」SQL 下推 + 60s 缓存；cloud-deploy 的 `/api/db/table` 通用浏览无 WHERE、limit≤500，**不能承载该读取模式**；workers/ 目录 grep `dingtalk` 零命中。
7. **安全/凭据差异**：ai-stock config.json 明文密钥且已随历史推送远端（PRD D8）；cloud-deploy 约定口令只进 `.dev.vars`/secrets、wrangler.jsonc 受版本控制不放明文——迁移涉及任何凭据时不能沿用 ai-stock 的 config.json 模式。
8. **MySQL 平台约束**：Hyperdrive 强制 TLS + 公网 IP；源库连接数上限 20（Free）/100（Paid）；ai-stock 灌库脚本本身就是「外部常驻 MySQL」形态（D4-3），与 Hyperdrive 前提一致；但 ai-stock 的 JSONL 存档（热门/涨停池/主力净额/复盘/AI 缓存）仍在本地文件系统，未入库（`dingtalk_message` 除外）。
9. **口径事实**：cloud-deploy `/api/kline` 的 `adjust=raw|hfq` 与 ai-stock `daily_bar.adjust` 主键一致；东财回退 fqt=0 与 raw 对齐（kline.js 注释）；复权口径混写会造成回测静默断裂是 ai-stock 仓库硬约定（backtest.md）。
10. **workers2/** 为历史/备用 Node Express 方案（端口 3000，代理路径 `/workers`），与 wrangler 部署无关；迁移评估不应把它当现役目标。

---

## 4. 覆盖度说明

| 检查项 | 结果 |
|---|---|
| 两仓库自述与规则（CODEBUDDY.md、CLAUDE.md、.codebuddy/rules/*.md ×10） | 有记录，全部读取 |
| ai-stock docs ×12（prd/gap-analysis/backtest-credibility 索引/strategy/shortline/hot-stocks/core-candidates/data-quality/event-verification 等标题与正文） | 有记录（strategy.md、shortline.md、prd.md、gap-analysis.md 全文；其余按标题结构核对，正文未逐字读） |
| ai-stock 关键源码（web/app.py 结构与导航、data/store.py DDL、data/fetcher.py 行数、data/kpl_hot.py、data/xinhua.py、scripts/sync_to_mysql.py） | 有记录 |
| ai-stock tests/ 清单 | 有记录（16 个 verify 脚本；断言内部未逐个展开） |
| cloud-deploy Worker 全部四个模块（index/db/kline/intraday） | 有记录，全文读取 |
| cloud-deploy 静态页（index.html 主体+脚本、其余 5 页标题与依赖、js/ 目录） | 有记录；news/qxlive/yidong/ztlive 的具体数据接口未逐一核对 |
| 线上 MySQL 实际表清单与数据量（是否已有 dingtalk_message、daily_bar 行数、同步新鲜度） | **未核查**（需连库，本次只读调查未连接任何数据库） |
| workers/stock 前端 JS 全部行为、.wrangler 本地状态、ai-stock research/ 与 _tmp/ 内容 | 未展开（非本次范围） |
| 外部网络查询 | 无（本次为零外部数据请求） |

**本次无不可用来源**；所有「未核查」项均因范围边界，非源故障。

## 5. 来源清单（均为本机文件读取，2026-11-17，一手）

- cloud-deploy：`CLAUDE.md`、`wrangler.jsonc`、`package.json`、`.dev.vars.example`、`workers/index.js`、`workers/db.js`、`workers/kline.js`、`workers/intraday.js`、`workers/stock/index.html`（主体）、`workers/stock/{amount,news,qxlive,yidong,ztlive}.html`（标题与依赖）、`workers/stock/js/`、`workers2/main.js`、`scripts/`、根目录 ls。
- ai-stock：`CODEBUDDY.md`、`.codebuddy/rules/`（architecture/data-flow/runtime-paths/backtest/signals/ai-analysis/storage-and-config/ui-conventions/data-quality/git-remotes ×10）、`docs/`（prd、gap-analysis、strategy、shortline 全文；其余标题）、`web/app.py`（导航 `_TITLES`、区域注释、行数 3853）、`web/` ls、`data/` ls、`data/store.py`（DDL 段）、`data/fetcher.py`（行数 836）、`data/kpl_hot.py`、`data/xinhua.py`、`scripts/sync_to_mysql.py`、`requirements.txt`、`config.json`（仅结构，密钥值未复制）、根目录与 `.codebuddy/rules` ls、`docs` 与 `tests` 清单（find）。
