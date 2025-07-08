/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const dxxHost = 'https://duanxianxia.cn'
// 更新路由定义
const routes = [
  { path: '/api/', target: dxxHost },
]

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/message':
        return new Response('Hello, World!')
      case '/random':
        return new Response(crypto.randomUUID())
      case '/test':
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

          return Response.json(data);
        } else {
          // 没有匹配的路由返回404
          return new Response('Not Found', { status: 404 })
        }
    }
  },
}
