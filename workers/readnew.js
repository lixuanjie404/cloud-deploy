// 构建完整的 HTML 页面
let glhInfo
export const htmlContent = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>财经资讯</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        padding: 20px;
        background-color: #f9f9f9;
      }
      .container {
        max-width: 800px;
        margin: 0 auto;
        background: white;
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      }
      h1 {
        color: #333;
        border-bottom: 1px solid #eee;
        padding-bottom: 10px;
      }
      .news-list {
        max-height: 500px;
        overflow-y: auto;
      }
      .news-item {
        padding: 15px 0;
        border-bottom: 1px solid #f0f0f0;
      }
      .news-time {
        color: #666;
        font-size: 0.9em;
        margin-right: 10px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>最新财经资讯</h1>
      <div class="news-list">
        ${glhInfo}  <!-- 这里插入API返回的HTML内容 -->
      </div>
    </div>
  </body>
  </html>
`

export async function getGlhInfo () {
  let glhInfo;
  var urlencoded = new URLSearchParams()
  urlencoded.append('name', 'glh')
  urlencoded.append('msgtype', 'all')
  var requestOptions = {
    method: 'POST',
    headers: {},
    body: urlencoded,
    redirect: 'follow'
  }
  await fetch('https://duanxianxia.com/api/getNewsByList', requestOptions)
    .then(response => response.json())
    .then(result => {
      console.log(result)
      glhInfo = result.html
    })
    .catch(error => console.log('error', error))
  return new Response(glhInfo, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'X-Custom-Header': 'CustomValue'
    }
  })

}

export async function getHtml () {
  let glhInfo;
  var urlencoded = new URLSearchParams()
  urlencoded.append('name', 'glh')
  urlencoded.append('msgtype', 'all')
  var requestOptions = {
    method: 'POST',
    headers: {},
    body: urlencoded,
    redirect: 'follow'
  }
  await fetch('https://duanxianxia.com/api/getNewsByList', requestOptions)
    .then(response => response.json())
    .then(result => {
      console.log(result)
      glhInfo = result.html
    })
    .catch(error => console.log('error', error))
  return new Response(glhInfo, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'X-Custom-Header': 'CustomValue'
    }
  })
}
