# ai-stock → cloud-deploy 能力迁移规划（v2）

- 日期：2026-11-17，状态：**规划稿 v2（待确认）**
- v2 变更（按 2026-11-17 用户反馈）：
  1. **ai-stock 项目后续将弃用** → 不再把它当常驻数据生产者，改为 **cloud-deploy Worker 自立**（自己取数、自己算、自己入库）；
  2. **不求全量迁移**：按 "Worker 平台能做的能力" 分批迁，一批一批做，每批独立可用；
  3. **主页不变**：index.html 现有结构/文案零改动，新功能页独立成下钻页，只以追加点击入口方式接入现有容器。
- 依据：调查报告 [ai-stock-迁移调查报告.md](ai-stock-迁移调查报告.md)、`.tmp/aistock-migration/{web-layer,data-layer,compute-layer}.md`。ai-stock 的定位从"生产者"降为 **参考实现 + 过渡期数据源**，最终弃用。

---

## 1. 一句话结论

> cloud-deploy Worker 自己长出这些能力：**Cron 定时 + 直连行情上游 REST（东财/腾讯等，本项目已有验证先例）+ JS 重写轻量计算 + MySQL 读写 + 下钻页展示**。ai-stock 退役后，仅钉钉群消息同步因依赖本机 dws CLI/OAuth 暂由本机脚本续灌。

## 2. Worker 能做什么（能力盘点，迁移范围按此划线）

| 能力 | 结论 | 依据 |
|---|---|---|
| 定时任务 | ✅ Cron Triggers（wrangler.jsonc `triggers.crons`），收盘后批量 + 盘中快照 | Workers 原生 |
| 直连行情上游 | ✅ 东财 push2/push2his/trends2 本项目已验证（kline.js/intraday.js）；腾讯 qt.gtimg、新浪 hq.sinajs 为 GBK 可解码；KPL（需 Dalvik UA）、涨停池、人气榜逐一实测 | 现有代码先例 + ai-stock data-layer 调查的接口清单 |
| MySQL 读写 | ✅ mysql2 + Hyperdrive 可执行写入（`INSERT … ON DUPLICATE KEY UPDATE`，除主键不加唯一索引）；**写入只发生在 Cron 处理器内，不暴露任何可写 HTTP 接口**，`/api/db/*` 保持现有只读安全面 | Hyperdrive 文档 + ai-stock store.py 的 upsert 约定 |
| JS 重写轻计算 | ✅ 4 个策略（双均线/MACD/N日突破/MA20穿越）、信号编排、市场环境档位、异动检测——原实现是纯 pandas 函数，可逐个翻译并与 Python 输出对拍 | compute-layer 调查：21/24 模块纯内存 |
| LLM / ima 直调 | ✅ fetch OpenAI 兼容接口 + ima OpenAPI，密钥走 Workers secrets | ai-stock analyzer/ima_kb 的调用面 |
| 回测引擎 | ⚠️ 单票回测（几百根日线循环）可 JS 移植，限制档位；**稳健性检测（最多 ~360 次回测）不迁**，如需仍本地跑 | compute-layer §7.2 |
| Python / akshare / dws | ❌ 不可运行。akshare 是上游 HTTP 的封装 → 改为直连同一批 REST 接口；钉钉 dws 依赖本机 OAuth → 过渡期本机脚本续灌 MySQL | 平台事实 |

**不迁清单**：Streamlit 壳与交互面板、akshare SDK、稳健性检测在线化、设置页（改为 wrangler vars + secrets + `app_config` 表）、Docker/Render 部署、16 个 verify 脚本。

## 3. 迁移批次（一部分一部分，每批独立可用、独立验收）

### 批次 A · 行情入库自主化（先把数据源握在自己手里）
- 内容：wrangler.jsonc 加 Cron（收盘后 15:05 北京 ≈ 07:05 UTC）；Worker scheduled 处理器拉 push2his（个股 fqt=0/2 = raw/hfq，指数 secid 直连）增量 upsert `daily_bar`；watchlist + 8 指数起步（清单放 wrangler vars，可扩）。
- 关键点：**首验 Hyperdrive 写入可用**（官方定位偏读，写入不经缓存但应可用；若受限，回退方案 = 新表落 D1 或源库侧配合）；复用现有 daily_bar schema，与 ai-stock 灌库口径一致（adjust 分主键、东财回退 fqt=0 已对齐 raw）。
- 效果：ai-stock 数据冻结（raw 止于 2026-10-20）的缺口由本项目接管，`/api/kline` 等既有接口立即受益。

### 批次 B · 快照采集（盘中/收盘 Cron）
- 内容：涨停池快照（东财接口，中性表名 `pool_snapshot`）、东财人气榜、KPL 双口径（Dalvik UA 实测）、主力净额前十（push2 clist 直连，本项目已有同款代码）→ 各自快照表；盘中 01:30–07:00 UTC 每 10 分钟 + 收盘后一次。
- 效果：行情页"近期热门/热门板块"、核心股、市场档位的数据底座。

### 批次 C · 信号计算（JS 重写 + 每日 Cron）
- 内容：4 个策略纯函数 JS 重写（rolling/ewm/diff，与 Python 对拍：同输入同输出，用 ai-stock 的固定序列/金线做基准）；市场环境档位（涨停家数/炸板率代理/连板高度/换手中位 → 4 档）；信号编排（watchlist → 动作 → 融合预留 AI 挂点，先不带 AI）；落 `daily_signal`、`market_env` 表。
- 保持 `info_lag=1` 语义：T 日收盘算、T+1 开盘执行。

### 批次 D · 前端下钻页 + 主页追加入口（主页不变）
- 新页：`daily.html`（信号热力表 + 市场档位 + 主力净额前十 + 快照浏览）、`hot.html`（近期热门 + 人气榜/KPL + 涨停池，池/榜内第二档词合规）、`core.html`（板块强度 + 重点标的候选，JS 重写 core_candidates 筛选规则）。
- 主页 index.html **仅**在现有顶栏菜单/资源卡容器内追加点击入口链接，不改任何现有结构/文案；入口文案过两档禁词闸。
- 配套 API（沿用 db.js 安全模式，仅 GET、标识符校验、limit 上限、Cache-Control）：`/api/feat/signals`、`/api/feat/env`、`/api/feat/candidates`、`/api/feat/mainflow`、`/api/feat/hot`、`/api/feat/pool`。
- 文案纪律：第一档（含"股"单字）全站禁 → 个股→"标的"、核心股→"重点标的"、A股→"市场"；复盘→"归档"、盯盘→"日志"；涨停/竞价/连板（第二档）只出现在下钻页/弹窗；表名/接口用中性命名。每步跑 `python scripts/check-ui-text.py --verbose`。

### 批次 E · 后续可选（按需再排）
- AI 报告：新闻/公告源直连（东财新闻/公告接口）+ LLM fetch（secrets）+ `ai_report` 表 + `ai.html` 只读报告页；
- 回测 JS 移植（限制档位）+ `sim.html` 演算页；
- 钉钉材料页（读 `dingtalk_message`，SQL 时间窗+关键词下推；**数据续灌依赖本机脚本**，可选：把钉钉同步剥离成独立 Python 脚本放进本项目 `scripts/`，为 ai-stock 彻底弃用铺路）。

> 批次依赖：A → B → C → D；E 独立按需。A/B/C 是"能力迁入"（Worker 自产数据），D 是"能力呈现"。

## 4. 存储设计（写入方 = Worker Cron）

| 表 | 内容 | 批次 |
|---|---|---|
| `daily_bar`（复用现有 schema） | 日线（raw/hfq/指数），增量 upsert | A |
| `pool_snapshot` | 涨停池快照（中性命名） | B |
| `hot_rank_snapshot` / `kpl_hot_snapshot` | 人气榜 / KPL 快照 | B |
| `main_flow_top10` | 主力净额前十（按日 + source 口径列） | B |
| `daily_signal` | 每日信号（code/日期/策略/动作/因子列） | C |
| `market_env` | 市场环境与总仓位档位（逐日一行） | C |
| `app_config` | watchlist/策略参数/开关（非敏感；敏感一律 secrets） | A 起 |
| `core_candidate` + `sector_strength` | 重点标的候选 + 板块强度 | D（若与 C 同 Cron 产出可提前） |
| `ai_report` / `ai_feedback` / `event_snapshot` / `news_snapshot` | AI 链路（批次 E） | E |

安全红线：写入仅存在于 Cron 处理器与内部模块；HTTP 层仍只有只读接口；`DB_TABLES` 白名单同步收口。

## 5. 页面映射（ai-stock 8 页 → 本项目，v2 口径）

| ai-stock 页面 | 去向 | 数据来源 | 批次 |
|---|---|---|---|
| 📈 行情（热门/板块/健康条） | `hot.html` 下钻页；K 线搜索复用已有 index 弹窗 | 批次 B 快照 + 既有 `/api/kline` | B/D |
| 🧪 回测 | 批次 E：`sim.html`（JS 移植后在线演算）；稳健性留本地 | 批次 E | E |
| 🔔 信号 | `daily.html` 下钻页 | 批次 C 表 | C/D |
| 🎯 核心股 | `core.html` 下钻页（文案改"重点标的"） | core_candidate 表 | D |
| 🔥 人气榜（KPL） | 并入 `hot.html` | kpl_hot_snapshot | B/D |
| 🤖 AI 分析 | 批次 E：`ai.html`（新闻直连 + LLM 生成 + 报告缓存） | ai_report 等 | E |
| 🛰️ AI 趋势 | `ai_trends.html` 静态拷贝（零后端，最易，可随 D 顺手带走） | 静态 | D |
| ⚙️ 设置 | 改为 wrangler vars + secrets + `app_config` 表，无 UI | — | A 起 |

## 6. 验收标准（每批独立）

1. 批次 A：本地 `npm run dev` 后 `curl --noproxy '*' http://127.0.0.1:8787/api/db/table/daily_bar?limit=3` 能看到新日期；`wrangler dev --test-scheduled` 触发 Cron 写入成功。
2. 批次 B/C：Cron 产物落表行数/口径与 ai-stock 参考实现对拍（策略信号同输入同输出；涨停池与东财页面当日一致）。
3. 批次 D：`python scripts/check-ui-text.py --verbose` 退出码 0；主页 diff 仅限追加的入口链接；下钻页打开可用。
4. 全程：数据接口返回数据截止日期，前端明示新鲜度，避免"死数据无提示"。

## 7. 需要你拍板的点

1. 批次顺序 A→B→C→D 是否认可（E 按需）；
2. 数据面宽度：先 watchlist 5 只 + 8 指数（推荐，后续可扩到全市场）；
3. 钉钉过渡方案：本机 `run_dingtalk_sync.py` 继续灌库，是否接受；是否要把同步脚本剥离进本项目 `scripts/`；
4. 批次 E 中 AI 报告 / 回测演算 / 钉钉材料页的优先级。

## 8. 风险

- **Hyperdrive 写入**：官方主读定位，写入应可用但需批次 A 首验；回退：新表落 D1 或评估源库直连。
- **非官方接口稳定性**：KPL 需 Dalvik UA、涨停池/人气榜无正式合同；多源降级链设计进 Cron（失败留空快照占位，不阻断）。
- **策略 JS 翻译口径**：pandas ewm/rolling 边界与 JS 实现必须对拍，否则信号静默漂移；用固定序列 + ai-stock 金线做基准。
- **Workers CPU 限额**：Free 计划单次调用 10ms CPU——Cron 内计算与拉取需控制规模（watchlist 小池没问题；扩全市场前先评估 Paid 计划）。
- **时区**：Cron 用 UTC，收盘后任务 = 周一至周五 07:05 UTC；节假日靠交易日历判断跳过（东财日历接口或指数日线判空）。
- **伪装与便利平衡**：新增页面文案量大，以 `check-ui-text.py` 为唯一闸门。
