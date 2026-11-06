// const express = require('express')
import express from 'express'
import path from 'path'
import { createProxyMiddleware } from 'http-proxy-middleware'
import compression from 'compression'
import helmet from 'helmet'

const __dirname = path.resolve()

const app = express()
const port = 3000
app.use(express.static('workers2/stock'))
app.use(helmet())
app.use(compression())

const dxxHost = 'http://duanxianxia.cn'

// 代理配置
const API_PROXY_TARGET = 'http://duanxianxia.cn/api' // 目标域名

// 中间件：将 /workers 开头的请求代理到目标域名
app.use(
  '/workers',
  createProxyMiddleware({
    target: API_PROXY_TARGET,
    changeOrigin: true, // 修改请求头中的 Host 为目标地址
    pathRewrite: {
      '^/api': '', // 去掉路径中的 /workers 前缀（根据需求调整）
    },
    onProxyReq: (proxyReq) => {
      // 可在此添加自定义请求头（可选）
      proxyReq.setHeader('X-Proxy-By', 'Express')
    },
  })
)

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/workers2/stock/index.html')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
