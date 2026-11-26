/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { handleDbRequest } from './db.js'
import { handleKlineRequest } from './kline.js'
import { handleIntradayRequest } from './intraday.js'
import { handleSuggestRequest } from './suggest.js'
import { handleFeatRequest } from './feat.js'
import { handleAnalyze } from './analyze/index.mjs'
import { handleSubmitTask, handleListTasks, handleGetTask } from './analyze/queue.mjs'
import { handlePush } from './push.js'
import { handleEvents } from './events.js'
import { scheduled as cronScheduled } from './cron.js'

const dxxHost = 'https://duanxianxia.cn'

// 更新路由定义
const routes = [
  { path: '/api/', target: dxxHost },
]

export default {
  // 定时批量拉取日线落表；读接口只读，催化分析异步补拉除外
  async scheduled (controller, env, ctx) {
    return cronScheduled(controller, env, ctx)
  },

  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    // MySQL 只读接口独立处理，不进入下面的代理逻辑
    if (url.pathname.startsWith('/api/db/')) {
      return handleDbRequest(request, env, url)
    }

    // 个股 K 线（仅 index 页面的单入口使用）
    if (url.pathname.startsWith('/api/kline/')) {
      return handleKlineRequest(request, env, url)
    }

    // 分时量能（今日进度 · 量）
    if (url.pathname.startsWith('/api/intraday/')) {
      return handleIntradayRequest(request, env, url)
    }

    // 标的检索（名称首字母 / 中文 / 代码前缀，仅 A 股；走势弹窗选标的用）
    if (url.pathname.startsWith('/api/suggest')) {
      return handleSuggestRequest(request, url)
    }

    // 辨识度因子（K 线类现拉现算，只读）
    if (url.pathname.startsWith('/api/feat/')) {
      return handleFeatRequest(request, env, url, ctx)
    }

    // 催化推演：事件源（钉钉从库/新华实时）
    if (url.pathname === '/api/catalyst/events') {
      return handleEvents(request, env, url)
    }

    // 催化推演：异步多阶分析任务队列（提交 / 列表 / 单任务详情）
    if (url.pathname === '/api/analyze/tasks') {
      return request.method === 'POST'
        ? handleSubmitTask(request, env, ctx)
        : handleListTasks(request, env, url)
    }
    if (url.pathname.startsWith('/api/analyze/tasks/')) {
      return handleGetTask(request, env, decodeURIComponent(url.pathname.slice('/api/analyze/tasks/'.length)))
    }

    // 催化推演：AI 多阶分析（同步接口，保留兼容；命中标的后 ctx.waitUntil 异步补拉日K入库）
    if (url.pathname === '/api/analyze') {
      return handleAnalyze(request, env, ctx)
    }

    // 催化推演：钉钉群机器人推送（上云）
    if (url.pathname === '/api/push') {
      return handlePush(request, env)
    }

    switch (url.pathname) {
      case '/message':
        return new Response('Hello, World!')
      case '/random':
        return new Response(crypto.randomUUID())
      case '/test':
      case '/uuid':
        debugger;
        return new Response(crypto.randomUUID())
      default:
        // 查找匹配的路由
        const matchedRoute = routes.find(route =>
          url.pathname.startsWith(route.path)
        )

        if (matchedRoute) {
          // 转发请求
          const response = await fetch(dxxHost + url.pathname, {
            method: request.method,
            body: request.body,
            headers: request.header
          })
          const data = await response.json()
          // debugger;

          let resp = Response.json(data)

          let cacheDuration = 1800;
          resp.headers.set('Cache-Control', `public, max-age=${cacheDuration}, s-maxage=${cacheDuration}`)
          return resp;
        } else {
          // 没有匹配的路由返回404
          return new Response('Not Found', { status: 404 })
        }
    }
  },
}
