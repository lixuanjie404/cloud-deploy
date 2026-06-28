# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本项目中提供操作指南。

## 项目概述

这是一个 **Cloudflare Workers** 项目，支持两种部署方式：
- **Cloudflare Workers**（生产环境）：`workers/index.js`
- **Express 服务器**（本地开发）：`workers2/main.js`

项目提供股票交易相关的静态 HTML 页面，并将 API 请求代理到后端 `duanxianxia.cn`。

## 网站定位与风格

**核心定位**：程序员上班时查看股票信息的工具，**表面伪装成技术文档/工作台**，避免被他人一眼看出是股票网站。

- 导航栏使用"信息工作台"、"数据中心"等中性词汇
- 页面布局偏向技术文档风格，包含代码角色、时间轴等元素
- AI 工具区域使用"轻量对话"、"深度推理"等开发相关描述
- 辅助功能隐藏在浮层菜单中，不直接暴露

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
