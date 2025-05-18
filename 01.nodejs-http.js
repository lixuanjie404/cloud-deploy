//导包
const http = require('http')
//创建实例
const server = http.createServer();
//绑定动作
server.on('request', (req, res) => {
    //拿到请求信息
    console.log('请求信息', req.url,req.method);
    // console.log('响应信息', res);
    console.log(res.statusCode,res.statusMessage);
    //响应请求
    let str=`请求信息=>路径 ${req.url},请求方法 ${req.method},请求码${res.statusCode}`;
    //设置请求头
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end(str)
})

//监听
server.listen(88,function () {
    console.log('http server run at http://127.0.0.1:88')
})
