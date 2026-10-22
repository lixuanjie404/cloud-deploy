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

**替代原则**：默认视图用工作台语境，如“归档”替代“复盘”、“值班”替代“盯盘”、“早上/中午/下午/傍晚”替代“盘前/盘中/尾盘/盘后”。

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

## 架构

### 入口文件
- **`workers/index.js`**: Cloudflare Workers 请求处理器 — 将 `/api/*` 请求代理到 `duanxianxia.cn` 后端，包含 30 分钟缓存

### 静态资源
- **`workers/stock/`**: 用于 Cloudflare Workers 部署的 HTML 和 JS 文件

### 路由逻辑（workers/index.js）
- `/message` → 返回 "Hello, World!"
- `/random` 或 `/uuid` → 返回随机 UUID（可设置调试器断点）
- `/api/*` → 代理到 `https://duanxianxia.cn/api/*`，使用 30 分钟缓存
- 其他路由 → 404

## 配置

- **`wrangler.jsonc`**: Cloudflare Workers 配置 — 使用 `workers/index.js` 作为入口，静态资源来自 `workers/stock/`，启用 Node.js 兼容性

## 代码规范

### JavaScript
- **不使用 `var`**，优先使用 `let` 和 `const`
- **优先使用 jQuery 选择元素**，如 `$('#id')`、$('.class')` 而非 `document.querySelector`
