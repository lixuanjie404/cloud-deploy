# ai-stock 功能梳理（迭代底册）

- 整理日期：2026-11-17。来源：对 `C:\Users\admin\lxj\ai-stock` 的四份只读调查（见文末索引），全部为代码级事实。
- 用途：ai-stock（Streamlit A 股个人量化看板）后续将**逐步弃用**，其功能按 Worker 能做的分批迁入本项目。本文档是**功能底册**：每批迭代前查这里，确认原功能的行为、口径与依赖，迁完在 §8 状态表打勾。
- 配套：[ai-stock-迁移规划.md](ai-stock-迁移规划.md)（批次计划）、[ai-stock-迁移调查报告.md](ai-stock-迁移调查报告.md)（迁移事实与两库连接）、`.tmp/aistock-migration/{web,data,compute}-layer.md`（调查底稿，含文件行号级引用）。
- 迭代纪律：**重实现功能时，先读 §7「口径与约定」**——这些是原系统踩坑后固化的口径，丢了会出现静默错误（复权断裂、信号漂移、展示串台等都有过真实事故）。

---

## 1. 系统一览

- **定位**：A 股个人量化看板，只读展示 + 信号提醒，**不可实盘**（docs/gap-analysis.md 自评：玩具级与业余工具级之间）。
- **技术栈**：Python ≥3.10 单进程 Streamlit（1.64.0）+ pandas/numpy/plotly + akshare 1.18.88 + requests + PyMySQL（可选）。入口 `python main.py` = `streamlit run web/app.py`（默认 8501，start 脚本走 8502）。
- **架构分层**：web（展示）/ data（取数+存储）/ strategy（4 策略）/ backtest（7 模块）/ signals（8 模块）/ ai_analysis（8 模块）。无 `__init__.py`（隐式命名空间包）；web/app.py 3853 行单文件，其余依赖页内懒加载 import。
- **页面**：实际 **8 页**（自述文档写 7 页已过时）：📈 行情 / 🧪 回测 / 🔔 信号 / 🎯 核心股 / 🔥 人气榜(KPL) / 🤖 AI分析 / 🛰️ AI趋势 / ⚙️ 设置。
- **调度现状**：看板无调度器，数据靠打开页面触发增量更新（曾 6 天空窗）；仅钉钉同步（本机定时）与 KPL 小时快照是脚本化定时。→ 迁移后由 Worker Cron 接管。

## 2. 页面功能明细（8 页）

### 2.1 📈 行情（每日看板）
- **自上而下**：数据质量状态条 → 近期热门第一屏（4 个指标卡 + 4 个子 tab：持续热门/今日人气榜/排名前进/涨停池）→ 侧栏选股与日期 → 4 个区间统计卡 → 三栏日 K → 公司概况 → 明细数据。
- **三栏日 K**：Plotly 蜡烛 + MA5/10/20/60 + 成交量 + MACD(12/26/9)；红涨绿跌；完整历史上先算指标再切片（视窗拖拽/缩放/双击复位、rangebreaks 去休市日、light/dark 两套主题）。
- **搜索**：全市场联想搜索框（streamlit-searchbox），候选 = 关注列表置顶⭐ + 搜索历史🕘 + 全市场匹配；选中写历史（上限 20 条）。
- **数据依赖**：`fetcher.get_daily/get_stock_list/get_stock_profile`、`hot_stocks.hot_board`（人气榜多日聚合+涨停池聚合，降级不阻断）、`quality`（健康条，默认只读最后一份巡检报告，点按钮才全量巡检）。

### 2.2 🧪 回测（策略回测）
- **模式 A：个股/指数策略回测**——5 个绩效卡（总收益/年化/最大回撤/夏普/胜率/笔数）→ 成交假设提示（佣金万三最低 5 元 + 卖出印花税万五、滑点 5bp）→ 未来函数审计绿勾/红字 → 稳健性检测（参数敏感 sweep≤120 组合 / 样本外 walk-forward≤240 / 成本压力 / 分年表 / 红旗）→ 净值 vs 买入持有(含费) 曲线 → 归因（β 对沪深300 + 行业贡献 + 残差 α + 逐笔 t 值）→ 被拦截委托 blocked → 交易明细。7 个成交假设控件：滑点 bp / 涨跌停 / 停牌跳过 / 停牌顺延 / T+1 / 整手 / 参与率上限。
- **模式 B：隔日超短（榜单选股）**——`shortline.py` 7 布尔因子选股（连板 1–2、封单/流通市值 ≥1%、首封 ≤10:00、零炸板、成交额 ≥2 亿、板块效应 ≥2 家、排除 ST/北交所/一字板）→ `portfolio.py` 组合回测（≤2 持仓、隔日强平「必卖≠必成交」、买单一律不顺延、同行业分散、仓位=市场档位×20%）→ 市场档位双轴图 + 按连板高度分层统计 + 逐日持仓快照。口径说明写在页面上（功能而非装饰）。
- **性质**：每次交互现算现渲，**零缓存不落盘**；稳健性检测最多 ~360 次回测，是全站最重计算。
- **可信度边界**（docs/backtest-credibility.md）：日线粒度、Sharpe 未减无风险利率、<30 笔区间不可信、绩效「方向可参考」≠实盘收益。示例：600127×双均线全历史稳健性判定「可信度低」。

### 2.3 🔔 信号（每日信号，6 个 tab）
| tab | 内容 | 要点 |
|---|---|---|
| 热门板块 | **双口径 radio**：研报口径（`hot_sectors`，250 日历史分位 + 距 MA200 + 换手率分位，默认）vs 资金流口径（`hot_boards`，当日截面 + 主力净流入 + 领涨股） | 两个口径并存，迁移时都要考虑 |
| 每日策略 | 复盘块：展示提示词 → 复制 → DeepSeek 跳转外链（q 参数实测上限 8202 字符）→ 粘贴原文 → 正则解析（涨跌家数/连板梯队/主线/情绪周期）→ 复盘卡片 + 历史**归档**回看；另有补跑按钮 | `build_daily_plan` 仅 import 未调用——**页面实际不渲染汇总操作计划**（文档与行为不符，迁移时不复制此 bug） |
| 个股信号 | watchlist 策略信号 → HTML 热力表（rowspan 分类分组：AI 强化→存疑→其他→复盘点名；列：信号/AI评级/距今/信号价/最新价/信号后涨跌/量比/成交额）→ 可排序明细 → 推送按钮 | AI 只强化/标疑**不翻转**；超 5 天提示失效 |
| 指数信号 | 同个股信号面板，targets=8 个宽基指数 | 上证/深成/创业板/科创50/沪深300/上证50/中证500/中证1000 |
| 主力净额前十 | 上色表格（主力净额条/涨跌幅/超大单/大单）+ 推送按钮 | **双口径**：东财主力净额（超大单+大单）为主、同花顺净主动买入为降级，`source` 列透传**绝不混读** |
| 资金流历史 | 按日 top10 列表（默认最近 7 天，可看 60 天） | jsonl 按日追加 |

- **推送**：邮件（smtp.qq.com:465 → 收件填钉钉邮箱的变通路径）+ Server酱；按 AI 强化→存疑→其他→复盘点名分组；**无重试、无留痕、失败仅 print**。

### 2.4 🎯 核心股（潜在核心股）
- 板块强度表（S/A/B/C 先验规则：涨停家数/连板高度/成交额/昨日家数）→ 候选名单（只在 S/A 板块选 1–3 板；三布尔因子=容量/时间/封单；角色标注；**失效位**；每板块 ≤2 只、总数 ≤12）→ 次日验证列（来自涨停池事实，caption 明示「断板反包要看 T+2，本页不下结论」）→ 单只核对跳转行情页。
- 依赖最近 5 个交易日涨停池；基准日 15:00 前自动取上一交易日。无图表。

### 2.5 🔥 人气榜（KPL）
- 盘中/复盘双口径榜单（开盘啦 `GetHotPHB` **非官方接口**，明示「跌停票也会进前排」）；列：排名/代码/名称/自选⭐/涨幅%/较上小时↑↓/变动↑↓；小时快照回看（与上一小时 diff）；实时拉取失败自动回退最近快照。
- 数据落 `kpl_hot_history.jsonl`，读取端按（口径,小时）去重。

### 2.6 🤖 AI 分析
- **报告读取**：作用域=标的+区间（切换即清附属状态防串台）；六段式报告 markdown + 舆情温度条（公告权重 2 + 7 天半衰期，[-100,+100]）。
- **生成步骤流**（st.status）：新闻四源聚合（东财新闻/巨潮公告/财联社电报/东财公告/研报/新华财经/新华公告，`kind` 列区分）→ 清洗（三层去重 + 词典情感）→ ima 知识库检索（利好/利空双向、单词检索+本地 MUST 过滤）→ 异动与事件核验（涨停/跌停/±5%/放量/跳空/阶段新低新高；龙虎榜 40 日/涨停池 5 日/概念/板块/行业资金/间接快讯，带 TTL 缓存；事件分级：公告确认>多源>单一，传闻只降不升）→ 钉钉群材料（唯一群「每日调研──破晓📈」，时间窗+别名匹配+去重+脱敏，群内转述一律弱证据）→ LLM 生成（OpenAI 兼容接口，六段式 + 末行 `MACHINE_VERDICT: stance;confidence;horizon` 解析落盘）。每步失败降级不阻断。
- **AI 结论闭环评估**：融合埋点 → horizon 日收益回补（惰性，展开才算）→ 命中率统计（样本 <15 标不足）。
- 区间 radio(半年/一年)+slider(7–730 天) 双向联动；不足 30 交易日拒绝分析；历史报告列表（默认 5 份）+ 逐份删除。

### 2.7 🛰️ AI 趋势
- 整页 = `web/ai_trends.html`（814 行）静态研究简报「AI 发展趋势 2025–26」：关键数据卡 / 六大切片 / 三极格局（内联 SVG）/ 2026 预测 / 来源口径。
- **零后端依赖、无 JS、无网络请求**——迁移最易，静态拷贝即可。

### 2.8 ⚙️ 设置（4 个 tab）
- 👀 关注与策略（watchlist 编辑 + K 线图风格）；🔔 推送渠道（邮件/Server酱）；🤖 AI 模型（**多模型档案** profiles 管理：新建/切换/删除至少保留一份/测试连接）；📚 ima 知识库（凭证 + 库列表检索 + 连接测试，MCP 数字 id 与 OpenAPI base64 id 不通用有即时报错）。
- 写盘约定：以磁盘最新值为底、只覆盖自己那段 + 原子写（整 dict 直写会互相覆盖）。

### 2.9 展示层辅助模块
| 模块 | 职责 | 备注 |
|---|---|---|
| viewmodel.py | 信号→展示表口径纯函数（分类/新鲜度/排序，AI 强化靠前存疑沉底） | 历史两次用户可见事故（切标的串台、复权价显示 -96%）都出在这层——重实现时口径必须保真 |
| ui_state.py | 搜索历史/偏好/会话存档三个 json 的持久化 | |
| health_view.py | 数据质量状态条（截止日/落后天数/异常计数，只报不修） | 默认不跑全量巡检（要几秒） |
| shortline_view.py | 隔日超短整页渲染 | app.py 不可 import，内含同款组件副本 |
| 全局组件 | 深色主题注入、搜索框、指标卡、plot_kline、HTML 热力表基建（rowspan 表 st.dataframe 做不到） | 视觉口径：红涨绿跌 `#F2555A/#4CB782`，数值符号始终保留不只靠颜色（WCAG） |

### 2.10 死代码与文档-代码差异（迁移时注意）
- `build_daily_plan` 从未被调用（每日策略 tab 不渲染汇总计划）；`per_trade_industry`、`market_env` 均 import 未用。
- 文档写 7 页实际 8 页；`data/kpl_hot.py`、`web/health_view.py`、`web/ai_trends.html` 未登记进 architecture.md。

## 3. 计算层模块清单（24 个 py，21 个纯内存计算）

### strategy/（1）
| 模块 | 功能 | 迁移判定 |
|---|---|---|
| strategies.py | 双均线 / MACD / N日突破 / MA20穿越；`STRATEGIES` 注册表含默认参数与 `info_lag=1`；`run_strategy` 统一入口 | **JS 重写**（批次 C），与 Python 对拍 |

### backtest/（7）
| 模块 | 功能 | 迁移判定 |
|---|---|---|
| engine.py | 单标的全仓进出回测（次日开盘成交、佣金/印花税、可选成交约束、顺延、末段强平、blocked）；每次回测自动跑未来函数审计 | JS 移植可做（批次 E，限制档位） |
| exec.py | A股成交约束纯函数集：板块限幅分档（30/688=20%、4/8=30%、主板 10%）、1996-12-16 前无限幅、涨跌停判定（昨收按除权因子折算）、停牌=不在日历、滑点、整手、参与率 | 随 engine 一起移植；涨跌停口径同时被异动检测复用（**同源**） |
| metrics.py | 绩效纯函数（两引擎共用防口径分叉） | 随 engine |
| portfolio.py | 组合回测（≤2 持仓、隔日强平、同行业分散、档位缩放资金） | 批次 E |
| attrib.py | 归因（β 60 日滚动回归 + 行业贡献 + 残差 α + t 值） | 批次 E |
| audit.py | 未来函数审计（AST 扫策略源码 shift 方向） | 若策略改为服务端固定实现，可离线做一次 |
| robust.py | 稳健性检测（sweep/walk_forward/cost_stress/yearly/红旗） | **不迁**（最多 ~360 次回测，Serverless 不适合）；需要时本地跑 |

### signals/（8）
| 模块 | 功能 | 迁移判定 |
|---|---|---|
| daily.py | 每日信号编排（watchlist + 复盘点名 → 策略 + AI 融合 + 推送邮件/Server酱 + 埋点） | JS 重写（批次 C）；推送改 Cron |
| fuse.py | AI 只强化/标疑不翻转；verdict 有效期（created+horizon）；分组排序 | JS 重写（轻） |
| main_flow.py | 主力净额前十（东财直连→akshare→同花顺降级链）+ jsonl 留痕 | 批次 B（push2 直连本项目已有同款代码） |
| plan.py | 每日策略拼装（judge_market/suggest_position/build_actions）——展示层未接 | 可随批次 C 顺带实现（补齐原系统缺的呈现） |
| position.py | 市场环境→总仓位档位（涨停家数/炸板率代理/连板高度/换手中位 → 0/0.4/0.7/1.0） | JS 重写（批次 C，依赖批次 B 涨停池快照） |
| review.py | DeepSeek 复盘长文本地解析（提示词模板/跳转链接/正则抽取/命中 watchlist） | 纯规则可 JS 重写（批次 D/E） |
| shortline.py | 隔日超短 7 因子选股（score 只用于排序不打分） | 批次 E |
| core_candidates.py | 板块强度 S/A/B/C + 1–3 板三因子筛选 + 角色标注 + 次日验证 | JS 重写（批次 D） |

### ai_analysis/（8）
| 模块 | 功能 | 迁移判定 |
|---|---|---|
| analyzer.py | LLM 报告（模型档案管理、五类材料格式化 [Q]/[N#]/[K#]/[E#]/[D#]、六段式 PROMPT、verdict 解析） | 批次 E（fetch LLM + secrets） |
| cache.py | 报告缓存（code+区间 → md/json/events/dingtalk 四件套；get_latest_conclusion 供融合） | 改 `ai_report` 表 |
| dingtalk_context.py | 群过滤 + 时间上界（防未来消息）+ 别名匹配 + 去重 + 脱敏 | 纯函数可 JS 重写 |
| event_check.py | 异动检测（复用 exec 涨跌停口径）+ 六类快照抓取（TTL 缓存）+ 事件分级 | JS 重写（批次 E）；抓取改 Cron |
| feedback.py | AI 闭环评估（埋点/去重/回补/统计） | 改 `ai_feedback` 表 |
| ima_kb.py | ima OpenAPI 三步链 + kb_id 缓存 + 利好利空双向分类 | 批次 E（fetch + secrets） |
| llm_client.py | Bearer 头（密钥只从 config/env 读） | secrets |
| news_clean.py | 新闻三层去重 + 词典情感 + 舆情温度（依赖 now 的时间衰减） | JS 可重写；温度预计算需按天快照 |

### 预计算 vs 在线算（划分结论）
- **每日收盘后可固定的截面/序列 → 全部可预计算落表**：信号+因子、市场档位、隔日候选、核心候选+板块强度、主力净额、人气/KPL/涨停池快照、AI verdict 与报告、埋点、异动、新闻清洗截面。原系统它们就是 JSONL/ai_cache 文件，迁移即形态转换。
- **用户自由参数驱动 → 必须在线**：单票/组合回测、归因、稳健性（不迁）、融合拼装（毫秒级）。
- **外部网络调用 → 服务端在线**：LLM/ima/akshare 系上游/推送；延续「缓存去重 + 失败降级不阻断」。

## 4. 数据层

### 4.1 外部数据源（akshare 本质是这些 HTTP 的封装——Worker 直连同款上游）
| 源 | 用途 | 关键约束 |
|---|---|---|
| 东财 push2/push2his/trends2 | 日线（fqt=0/2=raw/hfq）、主力净额排行、分时 | 本项目 kline.js/intraday.js **已验证**；需 UA/Referer + 公开 ut 常量 |
| 东财涨停池 `stock_zt_pool_em` | 按日涨停池（未来日期会返回最新一天，入口已拦截） | 快照口径：同日替换、盘中不写、空表写占位、原子写 |
| 东财人气榜 `emappdata` | 代码+名次（名称/价由新浪补） | 需 UA + `Referer: guba.eastmoney.com/rank/` |
| 开盘啦 KPL `apphq.longhuvip.com` | 盘中/复盘人气榜 | **必须 Dalvik UA**（Mozilla 返回空）；非官方无合同，按位置解析 |
| 腾讯 `qt.gtimg.cn` | 盘中实时快照补当日 K | GBK；`~` 分隔按位取值；手→股 ×100 |
| 新浪 `hq.sinajs.cn` | 批量行情（人气榜 50 只名称/价） | 需 `Referer: finance.sina.com.cn`；GBK；停牌价 0 退昨收 |
| 新浪日线 / 东财日线（akshare） | 个股日线主路径 + 降级 | 3 次退避重试 |
| 东财新闻/公告/研报、巨潮公告、财联社电报、新华财经 MCP | 新闻七源聚合（带 url 溯源列，电报无链接留空） | 研报接口无超时可能数十秒；新华需 Bearer |
| dws CLI（WorkBuddy） | 钉钉群消息唯一来源 | 依赖本机 OAuth；线上只能读 MySQL 中转表 |
| 交易日历（新浪） | `tool_trade_date_hist_sina`，TTL 30 天 | 降级链：日历→指数日线反推→工作日估算 |

- **多源新闻聚合** `get_stock_news_multi`：七源开关，单源失败只丢该源。
- **降级链（数据层固有行为，重实现要保留）**：新浪日线→东财日线；push2 直连→akshare 排行→同花顺净主动买入；hfq 因子→东财分红送配；日历→指数反推→工作日估算；存储 MySQL→SQLite。
- **脏数据防御**（已有 `_parse_amount/_strip_pct` 等，重实现沿用口径）：代码丢前导零需 `zfill(6)`、资金流重复行去重、金额单位亿/万/元混用。

### 4.2 存储
**MySQL/SQLite 六表**（两端 DDL 同在 store.py，表名一致）：
| 表 | 内容 | 备注 |
|---|---|---|
| `daily_bar` | 唯一日线缓存，主键 `(code, adjust, trade_date)` | adjust=raw/hfq/qfq/idx；指数 code 形如 `idx_sh000300`、adjust 恒 'idx'；实测 182,538 行 / 31 序列（watchlist 5 只 + 8 指数，**非全市场**），raw 止于 2026-10-20 |
| `stock_list` | 代码+名称（5,565 行） | |
| `stock_adj` | 除权除息日 + hfq 因子（TTL 7 天） | |
| `stock_industry` | 东财口径行业（TTL 30 天） | |
| `stock_profile` | 个股档案 JSON（行业/主营/市值，TTL 7 天） | |
| `dingtalk_message` | 钉钉中转表（独立 DDL） | message_id 主键、create_time 是**字符串**防日期漂移、INSERT IGNORE；读侧必须「时间窗+LIKE」下推（全量 711 条实测 125 秒，下推 4.6 秒）+ 60s 缓存 |

**JSONL/文件产物（未入库，迁移即转表）**：`zt_pool_history.jsonl`（37 日涨停池）、`hot_history.jsonl`（人气榜快照）、`kpl_hot_history.jsonl`（小时快照）、`main_flow_history.jsonl`（主力净额前十）、`ai_feedback.jsonl`（55 行埋点）、`review_history.jsonl`（复盘点名）、`quality_history.jsonl`（巡检报告）、`dingtalk/YYYY-MM.jsonl`（月分区，唯一 git 入库例外，写入前脱敏 QQ/手机/邮箱）、`ai_cache/{code}_{start}_{end}.md/.json/.events.json/.dingtalk.json`（AI 报告四件套）、`sector_heat.json`、`ui_history/ui_prefs/ui_session.json`。

**写入约定**：MySQL upsert 用 `INSERT … AS new ON DUPLICATE KEY UPDATE`，**除主键不得加唯一索引**（撞任意唯一键会误更新）；日期对外恒 'YYYY-MM-DD' 字符串；运行期文件只许落 `data/`、`ai_cache/`、`_tmp/` 三处（verify_layout.py 静态检查）。

### 4.3 脚本（scripts/）
| 脚本 | 功能 | 备注 |
|---|---|---|
| sync_to_mysql.py | SQLite→MySQL 灌 daily_bar + 4 元数据表，逐序列比对（行数/MIN-MAX/ROUND(SUM(close),6)） | 需 `DATABASE_URL`；`--dry-run`/`--truncate`；报告落 _tmp |
| run_dingtalk_sync.py | 定时：dws 拉群消息→月分区→best-effort 推 MySQL；`--commit` 只提交月分区文件不 push | 退出码 0-4（2=MySQL 写失败、4=git 失败必须告警）；120s 节流、自适应补拉 ≤30 天 |
| sync_dingtalk_to_mysql.py | 钉钉快照首次灌库（幂等 INSERT IGNORE） | 只动 dingtalk_message |
| export_dingtalk_chat.py | 会话历史手动导出（只读） | complete=true 且 failures 空才算全量 |
| kpl_hot_hourly.py | KPL 小时快照 | 供任务计划程序每小时调 |
| migrate_stock_db.py | v1→v2 一次性迁移（70 分表→daily_bar 单表） | 留作重迁/排障入口 |

## 5. 配置与凭据

`config.json`（唯一配置文件，**随仓库跟踪且含明文密钥**——弃用前必须轮换，PRD D8）：

```
watchlist: [600127, 000338, 688111, 002384, 000066]
strategy:  "MA20穿越"          params: {}
notify:    email{smtp.qq.com:465, to=钉钉邮箱} + serverchan{enabled:false}
ai:        provider/model/api_key + custom_base_url(zhenze OpenAI 兼容) + custom_model
           + ima_client_id/ima_api_key/ima_kb_id
           + profiles[{default=智谱GLM, p1=zhenze}] + active_profile="p1"
xinhua:    {enabled:true, api_key}      # 新华财经 MCP Bearer；env XHCJ_API_KEY 可覆盖
```

- `DATABASE_URL` 只走环境变量/`config/.env`，**绝不进 config.json**。
- 迁移侧对应：非敏感配置 → wrangler vars / `app_config` 表；密钥 → Workers secrets（绝不复制 config.json 模式）。

## 6. 测试与运行

- 启动：`python main.py`（streamlit 8501）；`start.sh/ps1/bat` 走 8502；Dockerfile 8501；已部署 Render（ai-stock.onrender.com，本项目首页有外链）。
- **16 个 verify 脚本**（无测试框架，断言脚本风格；改对应模块必跑）：

| 脚本 | 覆盖 |
|---|---|
| verify_backtest.py | 回测金线（baseline_v2.json + pinned_600127.csv，sha256）+ 账务不变量 + 成交模型，**ALL PASS 才可信** |
| verify_portfolio.py / verify_shortline.py / verify_position.py / verify_core_candidates.py | 组合回测 / 7 因子+纯度 / 4 档位 / 板块档位筛选 |
| verify_store.py | 存储纯函数 + 双后端读写语义 |
| verify_presentation.py | 展示层口径（分类/新鲜度/排序/列契约） |
| verify_dingtalk_context.py | 群过滤/未来消息隔离/去重/脱敏 |
| verify_kpl_hot.py / verify_hot_stocks.py | 榜单解析/快照幂等/降级 |
| verify_quality.py / verify_layout.py | 数据巡检 / 文件落点 |
| verify_model_profiles*.py / verify_review.py / verify_xinhua.py | 模型档案 / 复盘链接 / 新华提取 |

- 迁移时的对拍基准：**JS 重写的策略/筛选逻辑，用固定输入序列与 Python 输出逐位对拍**（尤其 pandas ewm/rolling 边界），金线资产在 `tests/baseline_v2.json`、`tests/pinned_600127.csv`。

## 7. 口径与约定（重实现必守——每条都有事故/设计理由背书）

1. **info_lag=1**：所有信号 T 日收盘算、T+1 开盘执行；新策略必须声明 info_lag，禁止行情列负向 shift（未来函数审计扫描）。
2. **复权口径**：hfq 跑策略/回测净值，**raw 判涨跌停与展示价**；daily_bar 主键含 adjust，复权口径混写 = 静默断裂；东财回退 fqt=0 与 raw 对齐。曾发现 hfq 复权比例两天异常（2026-10-19/21），raw 序列连续——异常期数据源待修。
3. **AI 融合只强化/标疑，不翻转**；verdict 按 created+horizon 判有效期；AI 缺失/过期/失败一律降级纯技术信号（放宽需 ≥15 条样本验证）。
4. **主力净额双口径绝不混读**：东财主力净额（超大单+大单）≠ 同花顺净主动买入（含散户），source 列透传。
5. **涨跌停判定**：板块限幅分档（30/688=20%、4/8=30%、主板 10%）、1996-12-16 前无限幅、昨收按除权因子折算、无涨跌幅特殊日放行；回测 exec 与异动检测**共用同一实现**（口径同源）。
6. **快照口径**：涨停池同日替换、盘中不写、空表写 count=0 占位、原子写；KPL 读取端按（口径,小时）去重。
7. **展示口径**：红涨绿跌 #F2555A/#4CB782；数值符号始终保留不只靠颜色；信号分类（买入/卖出/无信号/异常）与排序（AI 强化靠前存疑沉底）在纯函数层定死。
8. **降级不阻断**：任何数据源/材料步骤失败 → 丢该源/降级 + 明示口径（如「同花顺降级口径」「上一快照」），绝不整体报错。
9. **日期合同**：跨后端对外恒 'YYYY-MM-DD' 字符串；MySQL DATE / SQLite TEXT 在 store 边界归一。
10. **钉钉材料**：唯一群、as_of 时间上界防未来消息、别名匹配（代码数字边界）、去重、脱敏（QQ/手机/邮箱）；群内转述一律弱证据标「未核实」；读取必须 SQL 下推 + 60s 缓存。
11. **绩效表述**：回测数字「方向可参考」≠ 实盘收益；<30 笔不可信；隔日超短只覆盖市场档位那一半仓位（新闻历史不在库无法重放）。
12. **本项目 UI 禁词**（迁移呈现时）：第一档（含"股"单字/交易/盯盘/选股/两融/龙虎/盘前盘中尾盘盘后）全站禁现；第二档（涨停/跌停/复盘/竞价/连板）仅限菜单/弹窗/popover/下钻页；每步跑 `python scripts/check-ui-text.py`。

## 8. 迁移对照总表（迭代时在此打勾）

状态图例：☐ 未开始 · ◐ 进行中 · ☑ 已迁入本项目 · ✕ 决定不迁

| # | ai-stock 功能 | 原位置 | Worker 方案 | 批次 | 状态 |
|---|---|---|---|---|---|
| 1 | 日线入库与更新（watchlist+8 指数） | fetcher/store + 打开页面触发 | Cron 拉 push2his 增量 upsert `daily_bar` | A | ☐ |
| 2 | 涨停池快照 | hot_stocks.fetch_zt_day + zt_history | Cron → `pool_snapshot`（中性命名） | B | ☐ |
| 3 | 东财人气榜快照 | hot_stocks.fetch_hot_rank | Cron → `hot_rank_snapshot` | B | ☐ |
| 4 | KPL 盘中/复盘榜 + 小时快照 | kpl_hot + kpl_hot_hourly.py | Cron（Dalvik UA）→ `kpl_hot_snapshot` | B | ☐ |
| 5 | 主力净额前十 + 历史 | main_flow + main_flow_history | Cron push2 直连 → `main_flow_top10` | B | ☐ |
| 6 | 4 个策略信号 + 因子列 | strategies.py + daily.py | JS 重写 + 对拍 → `daily_signal`（Cron 每日收盘后） | C | ☐ |
| 7 | 市场环境与总仓位档位 | position.py | JS 重写 → `market_env` | C | ☐ |
| 8 | AI 融合（只强化/标疑） | fuse.py | JS 重写（先留 AI 挂点） | C | ☐ |
| 9 | 每日策略汇总（原页面缺失） | plan.py（死代码） | 补齐实现（信号+档位+主力净额拼装） | C/D | ☐ |
| 10 | 信号页呈现（热力表/主力净额/资金流历史） | app.py 信号页 | `daily.html` 下钻页 + `/api/feat/*` | D | ☐ |
| 11 | 近期热门/热门板块双口径呈现 | app.py 行情页 + hot_boards/hot_sectors | `hot.html` 下钻页 | D | ☐ |
| 12 | 核心股筛选与呈现 | core_candidates.py + 核心股页 | JS 重写筛选 → `core_candidate`/`sector_strength` + `core.html` | D | ☐ |
| 13 | 人气榜呈现（KPL 双口径+小时对比） | 人气榜页 | 并入 `hot.html` | D | ☐ |
| 14 | AI 趋势静态简报 | ai_trends.html | 静态拷贝 | D | ☐ |
| 15 | 主页入口（不改主页） | — | index.html 现有容器追加入口链接 | D | ☐ |
| 16 | 数据健康状态条 | health_view.py + quality.py | `/api/feat/health`（各表最新日期+落后天数） | D | ☐ |
| 17 | AI 报告生成与缓存 | analyzer/cache + 新闻七源 | 新闻源直连 + LLM fetch（secrets）→ `ai_report` 表 + `ai.html` | E | ☐ |
| 18 | 异动与事件核验 | event_check.py | Cron 快照 + JS 分级 → `event_snapshot` | E | ☐ |
| 19 | ima 知识库检索 | ima_kb.py | fetch + secrets | E | ☐ |
| 20 | AI 结论闭环评估 | feedback.py | `ai_feedback` 表 + 统计接口 | E | ☐ |
| 21 | 单票/组合回测（在线演算） | engine/portfolio/exec/metrics/attrib | JS 移植（限制档位）+ `sim.html`；金线对拍 | E | ☐ |
| 22 | 复盘解析（DeepSeek 粘贴文本） | review.py | JS 重写（输入=用户粘贴文本，在线） | E | ☐ |
| 23 | 钉钉群消息同步 | dws CLI + run_dingtalk_sync.py | **本机脚本续灌**（依赖 OAuth）；可选剥离脚本进本项目 scripts/ | 过渡 | ☐ |
| 24 | 钉钉材料检索呈现 | dingtalk_context + dingtalk_message | `/api/feat/dingtalk`（SQL 下推 + 60s 缓存） | E | ☐ |
| 25 | 推送（邮件/Server酱） | daily.push_signals | Cron + fetch（secrets）；补重试与留痕（原系统无） | E | ☐ |
| 26 | 稳健性检测在线化 | robust.py | **不迁**（~360 次回测）；需要时本地跑 | — | ✕ |
| 27 | 设置页（watchlist/推送/模型档案） | 设置页 | wrangler vars + secrets + `app_config` 表，无 UI | A 起 | ☐ |
| 28 | Streamlit 壳/Render 部署/verify 脚本 | — | 不迁（本项目自有 dev/deploy 体系） | — | ✕ |

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| 本文 | 功能底册（迭代查这里） |
| [ai-stock-迁移规划.md](ai-stock-迁移规划.md) | 批次 A–E 计划、存储设计、风险（v2：Worker 自立、主页不变） |
| [ai-stock-迁移调查报告.md](ai-stock-迁移调查报告.md) | 两项目连接通道、平台约束、迁移交叉事实 |
| `.tmp/aistock-migration/web-layer.md` | 展示层逐页调查（app.py 行号级引用） |
| `.tmp/aistock-migration/data-layer.md` | 数据源/存储/脚本调查（接口约束级引用） |
| `.tmp/aistock-migration/compute-layer.md` | 24 模块计算层调查（预计算/在线划分依据） |
