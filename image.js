addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const ALLOWED_HOSTNAME = 'wiki-img.davidx.top'

async function handleRequest(request) {
  const url = new URL(request.url)
  
  // 验证请求域名
  if (url.hostname !== ALLOWED_HOSTNAME) {
    return new Response('Invalid hostname', { status: 403 })
  }

  // 构建转发请求
  const fetchUrl = 'https://upload.wikimedia.org/' + url.pathname + url.search
  
  try {
    let response = await fetch(fetchUrl, {
      method: request.method,
      headers: request.headers
    })

    // 克隆响应并设置缓存
    response = new Response(response.body, response)
    response.headers.set('Access-Control-Allow-Origin', '*')
    
    // 设置缓存时间为7天
    response.headers.set('Cache-Control', 'public, max-age=604800')

    return response
  } catch (err) {
    return new Response('Error fetching: ' + err.message, { status: 500 })
  }
}
