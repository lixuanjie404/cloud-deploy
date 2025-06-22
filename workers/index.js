import { Hono } from 'hono'
// import { compress } from 'hono/compress'
import { serveStatic } from 'hono/cloudflare-workers'

// Start a Hono app
const app = new Hono()



// 中间件
// app.use('*', cors())          // 跨域支持
// app.use('*', compress())      // 压缩响应（类似 compression）
// app.use('*', secureHeaders()) // 安全头（类似 helmet）

// 静态文件托管（假设你的文件在 Workers 的 KV 存储中）
// app.use('/stock/*', serveStatic({ root: './stock' }))

// You may also register routes for non OpenAPI directly on Hono
app.get('/test', (c) => c.text('Hono!'))
app.get('/*', serveStatic({
  root: './stock'
}))

// 代理到 duanxianxia.cn
// app.use('/workers/*', async (c) => {
//   const url = new URL(c.req.path.replace('/workers', '/api'), 'http://duanxianxia.cn')
//   const proxyReq = new Request(url, {
//     method: c.req.method,
//     headers: c.req.raw.headers,
//     body: c.req.raw.body,
//   })
//
//   // 添加自定义头
//   proxyReq.headers.set('X-Proxy-By', 'Hono')
//
//   const response = await fetch(proxyReq)
//   return response
// })

// app.get('/', (req, res) => {
//   res.sendFile(__dirname + '/workers2/stock/index.html')
// })


// Export the Hono app
export default app

