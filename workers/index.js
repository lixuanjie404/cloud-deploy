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

const dxxHost = 'https://duanxianxia.cn'

// 更新路由定义
const routes = [
  { path: '/api/', target: dxxHost },
]

export default {
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
