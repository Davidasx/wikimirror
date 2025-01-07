addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

const CONFIG = {
    // 允许的访问域名
    ALLOWED_HOSTNAME: 'wiki.davidx.top',
    // 维基百科目标域名
    WIKI_HOSTNAME: 'wikipedia.org',
    // 资源域名映射
    REPLACE_RULES: {
        'upload.wikimedia.org': 'wiki-img.davidx.top',
        'www.wikipedia.org': 'wiki.davidx.top',
    },
    // 支持的语言
    SUPPORTED_LANGUAGES: ['en', 'ceb', 'de', 'fr', 'sv', 'nl', 'ru', 'es', 'it', 'pl', 'arz', 'zh', 'ja', 'uk', 'vi', 'war', 'ar', 'pt', 'fa', 'ca', 'id', 'sr', 'ko', 'no', 'tr', 'ce', 'fi', 'cs', 'hu', 'tt', 'ro', 'sh', 'eu', 'zh-min-nan', 'ms', 'he', 'eo', 'hy', 'da', 'bg', 'uz', 'cy', 'simple', 'sk', 'et', 'be', 'azb', 'el', 'kk', 'min', 'hr', 'lt', 'gl', 'ur', 'az', 'sl', 'lld', 'ka', 'nn', 'ta', 'th', 'hi', 'bn', 'mk', 'zh-yue', 'la', 'ast', 'lv', 'af', 'tg', 'my', 'te', 'sq', 'mr', 'mg', 'bs', 'sw', 'ku', 'oc', 'be-tarask', 'br', 'ml', 'nds', 'ky', 'lmo', 'jv', 'pnb', 'ckb', 'new', 'ht', 'vec', 'pms', 'lb', 'ba', 'su', 'ga', 'is', 'szl', 'cv', 'pa', 'fy', 'ha', 'io', 'mzn', 'glk', 'tl', 'an', 'wuu', 'diq', 'vo', 'ig', 'yo', 'sco', 'kn', 'ne', 'als', 'gu', 'avk', 'ia', 'crh', 'bar', 'ban', 'scn', 'bpy', 'mn', 'qu', 'nv', 'si', 'xmf', 'ps', 'frr', 'os', 'or', 'tum', 'sd', 'bcl', 'sah', 'bat-smg', 'cdo', 'gd', 'bug', 'yi', 'ilo', 'am', 'li', 'nap', 'gor', 'as', 'fo', 'mai', 'hsb', 'map-bms', 'shn', 'zh-classical', 'eml', 'ie', 'ace', 'wa', 'sa', 'hyw', 'sat', 'zu', 'zgh', 'sn', 'lij', 'mhr', 'hif', 'km', 'dag', 'bjn', 'mrj', 'mni', 'ary', 'hak', 'pam', 'rue', 'roa-tara', 'ug', 'bh', 'nso', 'co', 'tly', 'so', 'vls', 'nds-nl', 'mi', 'se', 'rw', 'myv', 'kaa', 'sc', 'ff', 'mdf', 'bo', 'mt', 'kw', 'vep', 'tk', 'kab', 'gv', 'gan', 'fiu-vro', 'skr', 'zea', 'ab', 'ks', 'smn', 'gn', 'pcd', 'frp', 'udm', 'kv', 'csb', 'ay', 'nrm', 'ang', 'ln', 'fur', 'olo', 'lfn', 'lez', 'pap', 'nah', 'mwl', 'lo', 'tw', 'stq', 'ext', 'rm', 'lad', 'gom', 'av', 'dty', 'tyv', 'koi', 'dsb', 'lg', 'cbk-zam', 'dv', 'ksh', 'za', 'blk', 'bxr', 'gag', 'bew', 'pfl', 'haw', 'szy', 'tcy', 'pag', 'tay', 'pi', 'fon', 'awa', 'kge', 'gpe', 'inh', 'krc', 'xh', 'atj', 'to', 'pdc', 'mnw', 'arc', 'shi', 'tn', 'om', 'dga', 'ki', 'nov', 'nia', 'jam', 'kbp', 'wo', 'xal', 'kbd', 'anp', 'nqo', 'kg', 'bi', 'roa-rup', 'tpi', 'mad', 'tet', 'guw', 'jbo', 'fj', 'pcm', 'kcg', 'lbe', 'cu', 'st', 'iba', 'ty', 'dtp', 'trv', 'sm', 'ami', 'srn', 'btm', 'alt', 'ltg', 'gcr', 'ny', 'ss', 'mos', 'kus', 'chr', 'ee', 'bbc', 'ts', 'got', 'gur', 'bm', 've', 'pih', 'rmy', 'fat', 'chy', 'rn', 'igl', 'guc', 'ik', 'ch', 'ady', 'rsk', 'pnt', 'iu', 'ann', 'pwn', 'dz', 'ti', 'sg', 'din', 'tdd', 'kl', 'bdr', 'nr', 'tig', 'cr'],
    // 增加图片扩展名配置
    IMAGE_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico']
}

async function handleRequest(request) {
    const url = new URL(request.url)

    // 验证域名
    if (url.hostname !== CONFIG.ALLOWED_HOSTNAME) {
        return new Response('Invalid hostname', { status: 403 })
    }

    // 验证语言并构建维基域名
    let wikiHost = `www.${CONFIG.WIKI_HOSTNAME}`
    let pathname = url.pathname

    // 检查路径中的语言代码
    const pathParts = pathname.split('/').filter(p => p)
    if (pathParts.length > 0 && CONFIG.SUPPORTED_LANGUAGES.includes(pathParts[0])) {
        const lang = pathParts[0]
        wikiHost = `${lang}.${CONFIG.WIKI_HOSTNAME}`
        // 移除URL中的语言部分
        pathname = '/' + pathParts.slice(1).join('/')
    }

    // 构建维基请求
    const fetchUrl = `https://${wikiHost}${pathname}${url.search}`

    try {
        let response = await fetch(fetchUrl, {
            method: request.method,
            headers: request.headers
        })

        // 检查是否为图片请求
        const isImage = CONFIG.IMAGE_EXTENSIONS.some(ext =>
            url.pathname.toLowerCase().endsWith(ext)
        )

        if (isImage) {
            // 图片请求直接返回二进制数据
            const newResponse = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            })
            newResponse.headers.set('Access-Control-Allow-Origin', '*')
            newResponse.headers.set('Cache-Control', 'public, max-age=86400')
            return newResponse
        }

        // 非图片请求保持原有处理逻辑
        let body = await response.text()

        // 替换资源域名
        for (const [from, to] of Object.entries(CONFIG.REPLACE_RULES)) {
            body = body.replaceAll(from, to)
        }

        // 替换维基域名
        for (const lang of CONFIG.SUPPORTED_LANGUAGES) {
            body = body.replaceAll(`${lang}.${CONFIG.WIKI_HOSTNAME}`, `${CONFIG.ALLOWED_HOSTNAME}/${lang}`)
        }

        if (pathParts.length > 0 && CONFIG.SUPPORTED_LANGUAGES.includes(pathParts[0])) {
            const lang = pathParts[0]
            // 处理各种可能包含URL的HTML属性
            body = body.replaceAll(/href="\/((?!\/)[^"]+)"/g, `href="/${lang}/$1"`)
            body = body.replaceAll(/src="\/((?!\/)[^"]+)"/g, `src="/${lang}/$1"`)
            body = body.replaceAll(/action="\/((?!\/)[^"]+)"/g, `action="/${lang}/$1"`)
            body = body.replaceAll(/data-src="\/((?!\/)[^"]+)"/g, `data-src="/${lang}/$1"`)
            body = body.replaceAll(/data-href="\/((?!\/)[^"]+)"/g, `data-href="/${lang}/$1"`)
            body = body.replaceAll(/url\("\/((?!\/)[^"]+)"\)/g, `url("/${lang}/$1")`)
        }


        // 构建新响应
        const newResponse = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        })

        // 设置响应头
        newResponse.headers.set('Access-Control-Allow-Origin', '*')
        newResponse.headers.set('Cache-Control', 'public, max-age=3600')

        return newResponse
    } catch (err) {
        return new Response('Error: ' + err.message, { status: 500 })
    }
}
