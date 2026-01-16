addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

const CONFIG = {
    ALLOWED_HOSTNAME: "wiki.davidx.top",
    WIKI_HOSTNAME: "wikipedia.org",
    REPLACE_RULES: {
        "upload.wikimedia.org": "wiki.davidx.top/image-proxy",
        "www.wikipedia.org": "wiki.davidx.top",
    },
    SUPPORTED_LANGUAGES: ['en', 'ceb', 'de', 'fr', 'sv', 'nl', 'ru', 'es', 'it', 'pl', 'arz', 'zh', 'ja', 'uk', 'vi', 'war', 'ar', 'pt', 'fa', 'ca', 'id', 'sr', 'ko', 'no', 'tr', 'ce', 'fi', 'cs', 'hu', 'tt', 'ro', 'sh', 'eu', 'zh-min-nan', 'ms', 'he', 'eo', 'hy', 'da', 'bg', 'uz', 'cy', 'simple', 'sk', 'et', 'be', 'azb', 'el', 'kk', 'min', 'hr', 'lt', 'gl', 'ur', 'az', 'sl', 'lld', 'ka', 'nn', 'ta', 'th', 'hi', 'bn', 'mk', 'zh-yue', 'la', 'ast', 'lv', 'af', 'tg', 'my', 'te', 'sq', 'mr', 'mg', 'bs', 'sw', 'ku', 'oc', 'be-tarask', 'br', 'ml', 'nds', 'ky', 'lmo', 'jv', 'pnb', 'ckb', 'new', 'ht', 'vec', 'pms', 'lb', 'ba', 'su', 'ga', 'is', 'szl', 'cv', 'pa', 'fy', 'ha', 'io', 'mzn', 'glk', 'tl', 'an', 'wuu', 'diq', 'vo', 'ig', 'yo', 'sco', 'kn', 'ne', 'als', 'gu', 'avk', 'ia', 'crh', 'bar', 'ban', 'scn', 'bpy', 'mn', 'qu', 'nv', 'si', 'xmf', 'ps', 'frr', 'os', 'or', 'tum', 'sd', 'bcl', 'sah', 'bat-smg', 'cdo', 'gd', 'bug', 'yi', 'ilo', 'am', 'li', 'nap', 'gor', 'as', 'fo', 'mai', 'hsb', 'map-bms', 'shn', 'zh-classical', 'eml', 'ie', 'ace', 'wa', 'sa', 'hyw', 'sat', 'zu', 'zgh', 'sn', 'lij', 'mhr', 'hif', 'km', 'dag', 'bjn', 'mrj', 'mni', 'ary', 'hak', 'pam', 'rue', 'roa-tara', 'ug', 'bh', 'nso', 'co', 'tly', 'so', 'vls', 'nds-nl', 'mi', 'se', 'rw', 'myv', 'kaa', 'sc', 'ff', 'mdf', 'bo', 'mt', 'kw', 'vep', 'tk', 'kab', 'gv', 'gan', 'fiu-vro', 'skr', 'zea', 'ab', 'ks', 'smn', 'gn', 'pcd', 'frp', 'udm', 'kv', 'csb', 'ay', 'nrm', 'ang', 'ln', 'fur', 'olo', 'lfn', 'lez', 'pap', 'nah', 'mwl', 'lo', 'tw', 'stq', 'ext', 'rm', 'lad', 'gom', 'av', 'dty', 'tyv', 'koi', 'dsb', 'lg', 'cbk-zam', 'dv', 'ksh', 'za', 'blk', 'bxr', 'gag', 'bew', 'pfl', 'haw', 'szy', 'tcy', 'pag', 'tay', 'pi', 'fon', 'awa', 'kge', 'gpe', 'inh', 'krc', 'xh', 'atj', 'to', 'pdc', 'mnw', 'arc', 'shi', 'tn', 'om', 'dga', 'ki', 'nov', 'nia', 'jam', 'kbp', 'wo', 'xal', 'kbd', 'anp', 'nqo', 'kg', 'bi', 'roa-rup', 'tpi', 'mad', 'tet', 'guw', 'jbo', 'fj', 'pcm', 'kcg', 'lbe', 'cu', 'st', 'iba', 'ty', 'dtp', 'trv', 'sm', 'ami', 'srn', 'btm', 'alt', 'ltg', 'gcr', 'ny', 'ss', 'mos', 'kus', 'chr', 'ee', 'bbc', 'ts', 'got', 'gur', 'bm', 've', 'pih', 'rmy', 'fat', 'chy', 'rn', 'igl', 'guc', 'ik', 'ch', 'ady', 'rsk', 'pnt', 'iu', 'ann', 'pwn', 'dz', 'ti', 'sg', 'din', 'tdd', 'kl', 'bdr', 'nr', 'tig', 'cr'],
    IMAGE_EXTENSIONS: [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".ico",
    ],
    // 统一 User-Agent（含 GitHub 仓库信息）
    COMMON_UA: "Wikimirror/1.0 (+https://github.com/Davidasx/wikimirror)",
};

function escapeForRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isImagePath(path) {
    return CONFIG.IMAGE_EXTENSIONS.some((ext) =>
        path.toLowerCase().endsWith(ext)
    );
}

function extractLangFromReferer(request) {
    const ref =
        request.headers.get("referer") || request.headers.get("referrer");
    if (!ref) return null;
    try {
        const u = new URL(ref);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length && CONFIG.SUPPORTED_LANGUAGES.includes(parts[0])) {
            return parts[0];
        }
    } catch (e) {}
    return null;
}

// 客户端补丁脚本（外部文件内容）
// 该脚本会拦截 fetch/XHR/link/form 并为以 /api/ /w/ /wiki/ 开头但无 lang 前缀的内部请求补上当前页面的 lang
const CLIENT_PATCH_CONTENT = `
(function(){
  try {
    var pathParts = location.pathname.split('/').filter(Boolean);
    var lang = pathParts[0];
    if (!lang) return;
    var prefixes = ['/api/', '/w/', '/wiki/'];
    function needsPatch(url) {
      if (!url) return false;
      if (url.indexOf('://') !== -1 || url.startsWith('//')) return false;
      if (!url.startsWith('/')) return false;
      for (var i = 0; i < prefixes.length; i++) {
        if (url.indexOf(prefixes[i]) === 0) return true;
      }
      return false;
    }
    function rewrite(url) {
      if (!needsPatch(url)) return url;
      if (url.indexOf('/' + lang + '/') === 0) return url;
      return '/' + lang + url;
    }
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = rewrite(input);
        } else if (input && input.url) {
          var newUrl = rewrite(input.url);
          if (newUrl !== input.url) {
            input = new Request(newUrl, {
              method: input.method || (init && init.method) || 'GET',
              headers: input.headers || (init && init.headers),
              body: input.body || (init && init.body),
              credentials: input.credentials || (init && init.credentials),
              redirect: input.redirect || (init && init.redirect) || 'follow'
            });
          }
        }
      } catch (e) {}
      return _fetch.apply(this, arguments);
    };
    (function(open){
      XMLHttpRequest.prototype.open = function(method, url) {
        try { url = rewrite(url); } catch(e) {}
        return open.apply(this, [method, url].concat(Array.prototype.slice.call(arguments,2)));
      }
    })(XMLHttpRequest.prototype.open);
    document.addEventListener('click', function(e){
      try {
        var a = e.target.closest && e.target.closest('a');
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href) return;
        if (needsPatch(href)) {
          a.setAttribute('href', rewrite(href));
        }
      } catch(e){}
    }, true);
    document.addEventListener('submit', function(e){
      try {
        var f = e.target;
        var action = f.getAttribute && f.getAttribute('action');
        if (!action) return;
        if (needsPatch(action)) {
          f.setAttribute('action', rewrite(action));
        }
      } catch(e){}
    }, true);
  } catch (err) {}
})();
`;

// helper: try to add our origin to script-src in CSP; fallback to deleting CSP if cannot safely patch
function adjustCSPHeader(headers, ourOrigin) {
    // headers is a Headers-like object (we'll work with plain string)
    const csp = headers.get("content-security-policy");
    if (!csp) {
        return; // nothing to do
    }
    try {
        // Basic parse: split directives, find script-src; if none, try default-src
        const parts = csp.split(";").map((p) => p.trim());
        let found = false;
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].startsWith("script-src")) {
                // append ourOrigin if not present
                if (parts[i].indexOf(ourOrigin) === -1) {
                    parts[i] = parts[i] + " " + ourOrigin;
                }
                found = true;
                break;
            }
        }
        if (!found) {
            // if no script-src but has default-src, attempt to append to default-src
            let defaultIndex = -1;
            for (let i = 0; i < parts.length; i++) {
                if (parts[i].startsWith("default-src")) {
                    defaultIndex = i;
                    break;
                }
            }
            if (defaultIndex >= 0) {
                if (parts[defaultIndex].indexOf(ourOrigin) === -1) {
                    parts[defaultIndex] = parts[defaultIndex] + " " + ourOrigin;
                }
                found = true;
            }
        }
        if (found) {
            headers.set("content-security-policy", parts.join("; "));
            return;
        }
    } catch (e) {
        // parsing failed -> fallthrough to delete
    }
    // fallback: delete CSP headers (less secure but ensures injected script runs)
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
}

// image proxy: map /image-proxy/<path> -> https://upload.wikimedia.org/<path>
async function handleImageProxy(request, imagePath) {
    const upstream = new URL(
        imagePath,
        "https://upload.wikimedia.org"
    ).toString();
    // use same UA
    const upstreamResp = await fetch(upstream, {
        method: request.method,
        headers: {
            Accept: request.headers.get("Accept") || "*/*",
            "User-Agent": CONFIG.COMMON_UA,
            Referer: request.headers.get("Referer") || "",
        },
        cf: { cacheEverything: true },
    });
    const resp = new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: upstreamResp.headers,
    });
    resp.headers.set("Access-Control-Allow-Origin", "*");
    resp.headers.set(
        "Cache-Control",
        "public, max-age=604800, s-maxage=604800"
    );
    return resp;
}

async function handleRequest(request) {
    const url = new URL(request.url);

    if (url.hostname !== CONFIG.ALLOWED_HOSTNAME) {
        return new Response("Invalid hostname", { status: 403 });
    }

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS,POST",
                "Access-Control-Allow-Headers":
                    "Content-Type,Accept,Authorization",
                Vary: "Origin",
            },
        });
    }

    // serve client script at /__wm_client__.js (cachable)
    if (url.pathname === "/__wm_client__.js") {
        return new Response(CLIENT_PATCH_CONTENT, {
            status: 200,
            headers: {
                "Content-Type": "application/javascript; charset=utf-8",
                "Cache-Control": "public, max-age=86400", // cache client script 1 day
            },
        });
    }

    // image proxy route: /image-proxy/<path...>
    if (url.pathname.startsWith("/image-proxy/")) {
        // reconstruct the remaining path after /image-proxy/
        const imagePath =
            url.pathname.replace("/image-proxy/", "") + url.search;
        try {
            return await handleImageProxy(request, imagePath);
        } catch (e) {
            return new Response("Image proxy error: " + e.message, {
                status: 500,
            });
        }
    }

    // 1) /wiki/... without language -> redirect to /en/wiki/...
    if (
        url.pathname.startsWith("/wiki/") &&
        !CONFIG.SUPPORTED_LANGUAGES.some((l) =>
            url.pathname.startsWith(`/${l}/`)
        )
    ) {
        return Response.redirect(
            `${url.origin}/en${url.pathname}${url.search}`,
            301
        );
    }

    // parse pathParts and language
    const parts = url.pathname.split("/").filter(Boolean);
    let lang = null;
    let upstreamPath = url.pathname;
    let upstreamHost = `www.${CONFIG.WIKI_HOSTNAME}`;

    if (parts.length && CONFIG.SUPPORTED_LANGUAGES.includes(parts[0])) {
        lang = parts[0];
        const rest = parts.slice(1);
        upstreamPath = "/" + rest.join("/");
        if (upstreamPath === "/") upstreamPath = "/";
        upstreamHost = `${lang}.${CONFIG.WIKI_HOSTNAME}`;
    }

    // Host-based API fallback (recover language from Referer or accept-language)
    if (
        !lang &&
        (url.pathname.startsWith("/w/rest.php") ||
            url.pathname.startsWith("/w/api.php") ||
            url.pathname.startsWith("/api/"))
    ) {
        const rlang = extractLangFromReferer(request);
        if (rlang) {
            lang = rlang;
            upstreamHost = `${lang}.${CONFIG.WIKI_HOSTNAME}`;
        } else {
            // try Accept-Language header as secondary hint (take first token)
            const al = request.headers.get("accept-language");
            if (al) {
                const candidate = al.split(",")[0].split("-")[0];
                if (
                    candidate &&
                    CONFIG.SUPPORTED_LANGUAGES.includes(candidate)
                ) {
                    lang = candidate;
                    upstreamHost = `${lang}.${CONFIG.WIKI_HOSTNAME}`;
                } else {
                    upstreamHost = `en.${CONFIG.WIKI_HOSTNAME}`;
                }
            } else {
                upstreamHost = `en.${CONFIG.WIKI_HOSTNAME}`;
            }
        }
    }

    const upstreamUrl = `https://${upstreamHost}${upstreamPath}${url.search}`;

    // image file extension handling (if user requests wiki.davidx.top/zh/path/to/foo.jpg directly)
    if (isImagePath(url.pathname)) {
        try {
            // route to upstreamHost (which may be lang-specific) but also could be upload.wikimedia if path indicates that
            const upstreamResp = await fetch(upstreamUrl, {
                method: request.method,
                headers: {
                    Accept: request.headers.get("Accept") || "*/*",
                    "User-Agent": CONFIG.COMMON_UA,
                    Referer: request.headers.get("Referer") || "",
                },
                cf: { cacheEverything: true },
            });
            const resp = new Response(upstreamResp.body, {
                status: upstreamResp.status,
                statusText: upstreamResp.statusText,
                headers: upstreamResp.headers,
            });
            resp.headers.set("Access-Control-Allow-Origin", "*");
            resp.headers.set(
                "Cache-Control",
                "public, max-age=604800, s-maxage=604800"
            );
            return resp;
        } catch (e) {
            return new Response("Image proxy error: " + e.message, {
                status: 500,
            });
        }
    }

    // forward minimal headers
    try {
        const forward = {};
        forward["User-Agent"] = CONFIG.COMMON_UA;
        if (request.headers.get("Accept"))
            forward["Accept"] = request.headers.get("Accept");
        if (request.headers.get("Referer"))
            forward["Referer"] = request.headers.get("Referer");
        if (request.headers.get("Accept-Language"))
            forward["Accept-Language"] = request.headers.get("Accept-Language");

        const upstreamResp = await fetch(upstreamUrl, {
            method: request.method,
            headers: forward,
            redirect: "follow",
        });

        const contentType = upstreamResp.headers.get("content-type") || "";
        // For non-HTML (API JSON, CSS, JS) passthrough but ensure CORS
        if (!contentType.includes("text/html")) {
            const j = new Response(upstreamResp.body, {
                status: upstreamResp.status,
                statusText: upstreamResp.statusText,
                headers: upstreamResp.headers,
            });
            j.headers.set("Access-Control-Allow-Origin", "*");
            j.headers.set("Cache-Control", "public, max-age=60, s-maxage=60");
            return j;
        }

        // HTML: read & perform replacements
        let body = await upstreamResp.text();

        // 1) replace resource domains
        for (const [from, to] of Object.entries(CONFIG.REPLACE_RULES)) {
            const re = new RegExp(escapeForRegex(from), "g");
            body = body.replace(re, to);
        }

        // 2) replace lang subdomain -> /lang path
        for (const l of CONFIG.SUPPORTED_LANGUAGES) {
            const domain = `${l}.${CONFIG.WIKI_HOSTNAME}`;
            body = body.replaceAll(domain, `${CONFIG.ALLOWED_HOSTNAME}/${l}`);
        }

        // 3) if current request is language-specific, add /{lang} prefix to absolute internal paths
        if (lang) {
            const p = `/${lang}`;
            body = body.replace(/href="\/((?!\/)[^"]*)"/g, `href="${p}/$1"`);
            body = body.replace(/src="\/((?!\/)[^"]*)"/g, `src="${p}/$1"`);
            body = body.replace(
                /action="\/((?!\/)[^"]*)"/g,
                `action="${p}/$1"`
            );
            body = body.replace(
                /data-src="\/((?!\/)[^"]*)"/g,
                `data-src="${p}/$1"`
            );
            body = body.replace(
                /data-href="\/((?!\/)[^"]*)"/g,
                `data-href="${p}/$1"`
            );
            body = body.replace(
                /url\\("\/((?!\/)[^"]+)"\\)/g,
                `url("${p}/$1")`
            );

            body = body.replace(/(["'(])\/(api\/[^"'\)\s>]+)/g, `$1${p}/$2`);
            body = body.replace(/(["'(])\/(w\/[^"'\)\s>]+)/g, `$1${p}/$2`);
            body = body.replace(/(["'(])\/(wiki\/[^"'\)\s>]+)/g, `$1${p}/$2`);
        }

        // Inject external client script (defer) so we avoid inline JS; ensures runtime patching of dynamic requests
        const scriptTag = `<script src="/__wm_client__.js" defer></script>`;
        if (body.indexOf(scriptTag) === -1) {
            if (body.indexOf("</head>") !== -1) {
                body = body.replace("</head>", scriptTag + "</head>");
            } else if (body.indexOf("</body>") !== -1) {
                body = body.replace("</body>", scriptTag + "</body>");
            } else {
                body = body + scriptTag;
            }
        }

        // clone headers and attempt to adjust CSP to allow our script (best effort)
        const newHeaders = new Headers(upstreamResp.headers);
        // try to add our origin to script-src or default-src; fallback: delete CSP
        adjustCSPHeader(newHeaders, `https://${CONFIG.ALLOWED_HOSTNAME}`);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Cache-Control", "public, max-age=3600, s-maxage=3600");

        const resp = new Response(body, {
            status: upstreamResp.status,
            statusText: upstreamResp.statusText,
            headers: newHeaders,
        });

        // cache at edge
        try {
            if (
                (request.method === "GET" || request.method === "HEAD") &&
                upstreamResp.status === 200
            ) {
                const cache = caches.default;
                const cacheKey = new Request(request.url, { method: "GET" });
                await cache.put(cacheKey, resp.clone());
            }
        } catch (e) {
            // ignore cache errors
            console.error("cache put failed", e);
        }

        return resp;
    } catch (err) {
        return new Response("Proxy error: " + err.message, { status: 500 });
    }
}
