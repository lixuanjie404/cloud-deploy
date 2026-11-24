# cloud-deploy

基于 Cloudflare Workers 的 A 股行情与催化推演工作台：行情数据接口、事件驱动的多阶 AI 分析、标的映射与钉钉推送，单 Worker 部署（前端静态资源 + API + 定时任务）。

## 功能

- **行情接口**：日 K 线、分时量能、辨识度因子，只读；数据源东方财富
- **催化推演**：事件源（钉钉群消息从库 / 新华财经实时）→ LLM 多阶推演 → 板块匹配 → 成分股 + 资金确认 → 卡片渲染
- **公司识别**：文中提及个股经东财名称搜索确定性还原（简称/拼音缩写 → 官方名称 + 代码），多候选简称附 F10 主营简介做语境消歧，不信任 LLM 记忆代码
- **定时落表**：Cron 每交易日收盘后增量写入日 K（`daily_bar`）；每小时聚合东财/同花顺/雪球/淘股吧热门人气股写入 `hot_stock`（辨识度候选池读表）；AI 分析命中标的后异步补拉日 K 入库
- **钉钉推送**：分析结果经群机器人 Webhook 推送（加签或关键词模式）

## 快速开始（本地）

依赖：Node.js、MySQL（可选）。

1. 拉取项目：
   ```bash
   git clone <仓库地址> cloud-deploy
   cd cloud-deploy
   npm install
   ```

2. 准备配置文件（供本地脚本使用）。把 `config.example.json` 复制到**项目上一层目录**，重命名为 `cloud-deploy.config.json`，填入真实值：
   - 目录结构：`<父目录>/cloud-deploy/`（项目）+ `<父目录>/cloud-deploy.config.json`（配置）
   - 配置段：`db`（数据库）、`llm`（模型 API Key）、`xinhua`（新华财经 Key）、`dws`（钉钉 CLI 路径与群名）、`watchlist`
   - 该文件含密钥，**不要提交到仓库**；仓库内只保留 `config.example.json` 模板

3. 准备 Worker 运行时变量。把 `.dev.vars.example` 复制为项目内 `.dev.vars`，填入 MySQL 与 LLM 密钥（按需追加 `XINHUA_KEY`、`DINGTALK_WEBHOOK`、`DINGTALK_SECRET`）。该文件已被 `.gitignore` 忽略。

4. 启动：
   ```bash
   npm run dev              # 本地站点 http://127.0.0.1:8787
   npm run catalyst:server  # 独立催化分析服务 http://127.0.0.1:8788（可选，线上不需要）
   ```
   `npm run dev` 会自动从配置文件拼出 Hyperdrive 本地连接串，无需手填。

5. 同步钉钉群消息到数据库（可选）：
   ```bash
   npm run sync:dingtalk             # 同步最近 1 天
   npm run sync:dingtalk -- --days 7 # 同步最近 7 天
   ```
   按 `message_id` 去重、幂等，数据落 `dingtalk_message` 表。依赖本机 `dws` CLI（钉钉 OAuth），只能在本机运行；如需定时同步，用本机计划任务/cron 周期调用。

配置加载规则（见 `scripts/config.mjs`）：**环境变量 > 上一层配置文件 > 内置默认值**；也可用 `CLOUD_DEPLOY_CONFIG` 环境变量指定配置文件绝对路径。

> 数据库是可选的：无数据库时候选池/因子等功能仍可运行（K 线现拉东财）；`/api/db/*`、Cron 落表、分析缓存需要数据库。

## 部署到 Cloudflare Workers

线上只部署一个 Worker（前端资源 + API + Cron），全部功能内置。

**1. 一次性配置敏感凭证**（wrangler secret，加密存储、不入库）：
```bash
npx wrangler secret put LLM_API_KEY        # 智谱兼容接口 Key
npx wrangler secret put OPENROUTER_API_KEY # OpenRouter Key（可选）
npx wrangler secret put XINHUA_KEY         # 新华财经 MCP Key
npx wrangler secret put DINGTALK_WEBHOOK   # 钉钉群机器人 Webhook 地址
npx wrangler secret put DINGTALK_SECRET    # 钉钉加签密钥（SEC 开头）
```
> 钉钉若用"自定义关键词"模式，改设 `DINGTALK_KEYWORD` 而非 `DINGTALK_SECRET`。

**2. 部署**：
```bash
npm run deploy
```

部署说明：
- `triggers.crons`、`vars`（watchlist / 指数 / LLM 通道）、`hyperdrive` 绑定均已在 `wrangler.jsonc`，无需额外配置
- `hyperdrive` 的 `id` 指向已创建的 Hyperdrive 配置；**换 Cloudflare 账号时需换成该账号下的 id**
- Workers 不读本地配置文件；钉钉群消息靠本机 `npm run sync:dingtalk` 落库，Worker 从库读取（钉钉开放平台限制：群机器人 Webhook 只能发不能收）

### LLM 通道

非敏感通道配置在 `wrangler.jsonc` 的 `LLM_PROVIDERS`（JSON 数组，按序降级，未配置密钥的通道自动跳过）：

1. 智谱 `glm-4-flash-250414`（`LLM_API_KEY`）——主通道，账户需有可用余额
2. OpenRouter 免费模型 `openrouter/free`（`OPENROUTER_API_KEY`）——兜底

简称消歧优先使用 OpenRouter 的 `baidu/ernie-5.5-flash-preview:free`（中文知识更强），失败按序降级到上述通道。OpenRouter 免费模型有 50 次/天限额（账户累计充值 $10 后升到 1000 次/天），失败请求也计数，详见 OpenRouter 官方文档。

## API 一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/db/health` `/api/db/tables` `/api/db/table/:name` | GET | 数据库只读查询（可配 `DB_TABLES` 白名单） |
| `/api/kline/*` | GET | 个股日 K（优先读表，回退现拉） |
| `/api/intraday/*` | GET | 分时量能（含竞价） |
| `/api/feat/*` | GET | 辨识度因子（现拉现算）；候选池热榜读 `hot_stock`（每小时四源聚合），涨幅/成交额榜补非涨停强势股 |
| `/api/catalyst/events` | GET | 催化事件源（钉钉从库 / 新华实时） |
| `/api/analyze` | POST | AI 多阶分析：`{event:{title,content},refresh?}`，结果带 MySQL 缓存 |
| `/api/push` | POST | 分析结果推送钉钉群 |

## 项目结构

```
workers/            Worker 源码（main: workers/index.js）
  index.js          路由入口 + Cron 注册
  analyze/          催化推演（prompt/LLM/标的映射/公司识别/缓存/卡片）
  fetch/            东方财富行情封装（日线/板块/情绪池/名称搜索/F10）+ 四源热榜（hot.js）
  cron.js           定时日线落表 + 每小时热榜落表
  store.js          daily_bar / hot_stock 读写（mysql2 + Hyperdrive）
  db.js kline.js intraday.js feat.js   只读行情接口
  events.js push.js                    事件源与钉钉推送
  stock/            前端静态资源（wrangler assets）
scripts/            本地脚本
  config.mjs        统一配置加载器
  wrangler-dev.mjs  本地 dev 启动器（拼 Hyperdrive 连接串）
  sync-dingtalk.mjs 钉钉群消息同步
  catalyst/         独立催化分析服务（本地可选）
wrangler.jsonc      Worker 配置（vars / cron / hyperdrive / assets）
config.example.json 上一层配置文件模板
.dev.vars.example   本地 Worker 变量模板
```