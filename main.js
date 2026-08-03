/**
 * wikimirror — 用 Cloudflare Workers 搭建的 Wikipedia 镜像
 * https://github.com/Davidasx/wikimirror
 *
 * 设计要点
 * ---------------------------------------------------------------------------
 * 1. 语言不再打表。语言码有固定形状（见 LANG_SHAPE），而 MediaWiki 自己的根路径
 *    里只有 api / www / cdn-cgi 三个会撞上这个形状，列入 NOT_A_LANG 即可。
 *    再叠加一层权威校验：从 meta.wikimedia.org 的 sitematrix 拉真实语言集合，
 *    缓存在边缘，异步刷新，失败则放行（fail-open），永不阻塞请求。
 *
 * 2. 所有维基媒体家族域名都走镜像，页面不会再直连上游。
 *      /<lang>/<path>              -> <lang>.wikipedia.org/<path>
 *      /-/<hostname>/<path>        -> <hostname>/<path>   （家族域名白名单内）
 *      /                           -> www.wikipedia.org   （门户）
 *    这解决了 issue #1：ResourceLoader 的模块源 mw.loader.addSource() 里写的是
 *    绝对地址 https://<lang>.wikipedia.org/w/load.php，它在 JS 响应里，旧版只改写
 *    text/html 所以原样漏给了浏览器，导致所有按需加载的模块（折叠表格、导航框
 *    展开、参考文献浮窗、页面预览、多媒体查看器……）都去直连上游而失败。
 *
 * 3. HTML 用 HTMLRewriter 流式改写（不再对 1.4MB 正文做几百遍 replaceAll，
 *    这是旧版 Error 1102 CPU 超时的根因）；JS / CSS / JSON / XML 做定向文本改写；
 *    二进制原样流式转发。
 *
 * 4. 注入的客户端补丁是内联且同步的，保证在 async 的 startup 模块之前执行，
 *    并且拦截动态 <script>/<link> 的 src/href（mw.loader 正是用它加载模块）。
 *
 * 5. 无需改代码即可部署：镜像域名从请求本身推导，不存在需要全局替换的常量。
 */

// ===========================================================================
// 配置
// ===========================================================================

const CFG = {
    // 可选的主机名白名单。留空 = 接受任何绑定到本 Worker 的域名（推荐）。
    ALLOWED_HOSTNAMES: [],

    // 无法从 Referer / Accept-Language 推断语言时的兜底
    DEFAULT_LANG: "en",

    UA: "Wikimirror/2.0 (+https://github.com/Davidasx/wikimirror)",

    // 通用跨站代理前缀：/-/<hostname>/<path>
    HOST_PREFIX: "/-",

    // sitematrix 缓存时长（秒）
    LANGSET_TTL: 604800,
};

/**
 * 语言码形状。已对全部 296 个真实维基百科语言码验证通过，零漏判。
 * 覆盖 zh-min-nan / be-tarask / bat-smg / map-bms / zh-classical / roa-rup /
 * cbk-zam / fiu-vro / nds-nl / roa-tara 这类带连字符的历史码，以及 simple。
 */
const LANG_SHAPE = /^(?:simple|[a-z]{2,3}(?:-[a-z0-9]{2,10}){0,2})$/;

/** 形状上像语言码、但实际是 MediaWiki / Cloudflare 的路径，必须排除。 */
const NOT_A_LANG = new Set(["api", "www", "cdn-cgi"]);

/** 镜像自己拥有的首段：绝不给它们加语言前缀。 */
const NO_PREFIX = new Set(["-", "image-proxy", "cdn-cgi"]);

/** 允许经 /-/<host>/ 代理的维基媒体家族域名。 */
const FAMILY_HOST =
    /^(?:[a-z0-9-]+\.)*(?:wikipedia|wikimedia|wikimediafoundation|wikidata|wiktionary|wikibooks|wikiquote|wikisource|wikinews|wikiversity|wikivoyage|wikifunctions|mediawiki|toolforge|wmcloud|wmflabs)\.org$/i;

/** 需要做文本改写的 content-type。 */
const TEXTUAL =
    /^(?:application\/(?:x-)?(?:java|ecma)script|text\/(?:java|ecma)script|application\/json|application\/ld\+json|text\/css|text\/xml|application\/xml|application\/rss\+xml|application\/opensearchdescription\+xml)/i;

/** 超过这个大小的文本响应直接透传，避免无谓的 CPU 消耗。 */
const MAX_REWRITE_BYTES = 12 * 1024 * 1024;

/**
 * 只在浏览器与上游之间放行这几个 Cookie —— 全是匿名读者的显示偏好：
 *   mf_useformat        移动版 / 桌面版视图（点「移动版视图」就是靠它生效）
 *   stopMobileRedirect  抑制自动跳转到移动版
 *   mwclientpreferences 夜间模式、字号、限制宽度
 * 其余一律丢弃：WMF-Uniq / GeoIP / WMF-Last-Access 这些追踪 Cookie 会让上游
 * 隔着镜像给访客打指纹，会话 Cookie 又用不上（不支持登录），留着只会打碎缓存。
 */
const COOKIE_ALLOWLIST = new Set([
    "mf_useformat",
    "stopMobileRedirect",
    "mwclientpreferences",
]);

// ===========================================================================
// 语言判定
// ===========================================================================

/** sitematrix 拉到的权威语言集合；null = 尚未就绪（此时只用形状判定）。 */
let LANG_SET = null;
let LANGSET_INFLIGHT = null;

function isLangCode(seg) {
    if (!seg) return false;
    const s = seg.toLowerCase();
    if (NOT_A_LANG.has(s) || !LANG_SHAPE.test(s)) return false;
    // 权威集合就绪后用它兜底否决拼写错误 / 不存在的语言
    if (LANG_SET && LANG_SET.size && !LANG_SET.has(s)) return false;
    return true;
}

/**
 * 从 meta.wikimedia.org 拉取真实存在的维基百科语言码。
 * 结果缓存在边缘（LANGSET_TTL），任何失败都 fail-open（保持 LANG_SET 为空）。
 */
async function refreshLangSet(mirrorOrigin) {
    if (LANGSET_INFLIGHT) return LANGSET_INFLIGHT;
    LANGSET_INFLIGHT = (async () => {
        const cacheKey = new Request(`${mirrorOrigin}/-/__langset`);
        const cache = caches.default;
        try {
            const hit = await cache.match(cacheKey);
            if (hit) {
                const codes = await hit.json();
                if (Array.isArray(codes) && codes.length) {
                    LANG_SET = new Set(codes);
                    return LANG_SET;
                }
            }
        } catch (e) {
            /* 缓存不可用则继续走网络 */
        }

        try {
            const api =
                "https://meta.wikimedia.org/w/api.php" +
                "?action=sitematrix&format=json&formatversion=2" +
                "&smtype=language&smstate=all";
            const resp = await fetch(api, {
                headers: { "User-Agent": CFG.UA, Accept: "application/json" },
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            const matrix = data && data.sitematrix;
            if (!matrix) return null;

            const codes = new Set();
            for (const key of Object.keys(matrix)) {
                if (!/^\d+$/.test(key)) continue;
                const sites = matrix[key] && matrix[key].site;
                if (!Array.isArray(sites)) continue;
                for (const site of sites) {
                    if (!site || site.code !== "wiki" || !site.url) continue;
                    // 语言码取 URL 里的实际子域，而不是 sitematrix 的 code 字段
                    // （例如闽南语 code 是 "nan"，但域名是 zh-min-nan.wikipedia.org）
                    const m = /^https?:\/\/([a-z0-9-]+)\.wikipedia\.org/i.exec(
                        site.url
                    );
                    if (m) codes.add(m[1].toLowerCase());
                }
            }
            if (!codes.size) return null;

            LANG_SET = codes;
            try {
                await cache.put(
                    cacheKey,
                    new Response(JSON.stringify([...codes]), {
                        headers: {
                            "Content-Type": "application/json",
                            "Cache-Control": `public, max-age=${CFG.LANGSET_TTL}`,
                        },
                    })
                );
            } catch (e) {
                /* 写缓存失败无所谓 */
            }
            return LANG_SET;
        } catch (e) {
            return null; // fail-open
        } finally {
            LANGSET_INFLIGHT = null;
        }
    })();
    return LANGSET_INFLIGHT;
}

// ===========================================================================
// 路由：镜像路径 <-> 上游主机
// ===========================================================================

/**
 * 解析请求路径，得到 { prefix, host, path }。
 *   prefix ""              -> www.wikipedia.org（门户）
 *   prefix "/zh"           -> zh.wikipedia.org
 *   prefix "/-/<hostname>" -> <hostname>
 * 无法归类时返回 null（交给无前缀兜底逻辑）。
 */
function resolveRoute(pathname) {
    const parts = pathname.split("/").filter(Boolean);

    if (!parts.length) {
        return { prefix: "", host: "www.wikipedia.org", path: "/" };
    }

    // 通用跨站代理 /-/<hostname>/<path>
    if (parts[0] === "-") {
        const host = (parts[1] || "").toLowerCase();
        if (!host || !FAMILY_HOST.test(host)) return null;
        return {
            prefix: `/-/${host}`,
            host,
            path: "/" + parts.slice(2).join("/"),
        };
    }

    // 兼容旧版 /image-proxy/<path>
    if (parts[0] === "image-proxy") {
        return {
            prefix: "/-/upload.wikimedia.org",
            host: "upload.wikimedia.org",
            path: "/" + parts.slice(1).join("/"),
        };
    }

    if (isLangCode(parts[0])) {
        const lang = parts[0].toLowerCase();
        return {
            prefix: `/${lang}`,
            host: `${lang}.wikipedia.org`,
            path: "/" + parts.slice(1).join("/"),
        };
    }

    return null;
}

/** 从 prefix 反推上游主机，用于 Referer 兜底。 */
function hostFromPrefix(prefix) {
    if (!prefix) return "www.wikipedia.org";
    const parts = prefix.split("/").filter(Boolean);
    if (parts[0] === "-") return parts[1] || null;
    return isLangCode(parts[0]) ? `${parts[0].toLowerCase()}.wikipedia.org` : null;
}

/** 从 Referer 里恢复镜像前缀（同源子资源请求会带完整路径的 Referer）。 */
function prefixFromReferer(request, mirrorHost) {
    const ref = request.headers.get("referer");
    if (!ref) return null;
    try {
        const u = new URL(ref);
        if (u.host !== mirrorHost) return null;
        const route = resolveRoute(u.pathname);
        return route ? route.prefix : "";
    } catch (e) {
        return null;
    }
}

/** 从 Accept-Language 猜一个语言前缀。 */
function prefixFromAcceptLanguage(request) {
    const al = request.headers.get("accept-language");
    if (!al) return null;
    for (const item of al.split(",")) {
        const tag = item.split(";")[0].trim().toLowerCase();
        if (!tag || tag === "*") continue;
        if (isLangCode(tag)) return `/${tag}`;
        const base = tag.split("-")[0];
        if (isLangCode(base)) return `/${base}`;
    }
    return null;
}

// ===========================================================================
// URL 改写
// ===========================================================================

/** 上游主机名 -> 镜像 origin + 前缀。无需改写时返回 null。 */
function mirrorForHost(host, mirrorOrigin) {
    const h = host.toLowerCase();
    if (h === "www.wikipedia.org" || h === "wikipedia.org") return mirrorOrigin;
    const m = /^([a-z0-9-]+)\.wikipedia\.org$/.exec(h);
    if (m && isLangCode(m[1])) return `${mirrorOrigin}/${m[1]}`;
    if (FAMILY_HOST.test(h)) return `${mirrorOrigin}${CFG.HOST_PREFIX}/${h}`;
    return null;
}

const SKIP_SCHEME = /^(?:data|blob|javascript|mailto|tel|about|magnet|geo):/i;

/**
 * 改写单个 URL：
 *   - 维基媒体家族的绝对地址 -> 镜像路径
 *   - 根相对路径 -> 补上当前镜像前缀
 *   - 其余原样返回
 */
function rewriteUrl(raw, ctx) {
    if (typeof raw !== "string") return raw;
    const s = raw.trim();
    if (!s || s[0] === "#" || SKIP_SCHEME.test(s)) return raw;

    // 协议相对：//host/path
    if (s.startsWith("//")) {
        const host = s.slice(2).split(/[/?#]/)[0];
        const target = mirrorForHost(host, ctx.origin);
        return target ? target + s.slice(2 + host.length) : raw;
    }

    // 绝对地址
    const abs = /^https?:\/\/([^/?#]+)/i.exec(s);
    if (abs) {
        const target = mirrorForHost(abs[1], ctx.origin);
        return target ? target + s.slice(abs[0].length) : raw;
    }

    // 根相对
    if (s[0] === "/") {
        if (s[1] === "/") return raw; // 已在上面处理，防御性分支
        const slash = s.indexOf("/", 1);
        const seg = (slash < 0 ? s.slice(1) : s.slice(1, slash)).toLowerCase();
        if (NO_PREFIX.has(seg)) return raw; // 镜像自己的路径
        if (isLangCode(seg)) return raw; // 已经带了语言前缀
        return ctx.prefix + s;
    }

    return raw; // 相对路径由浏览器按当前 URL 解析，天然正确
}

/** 改写 srcset / imagesrcset（逗号分隔，每项 "url 描述符"）。 */
function rewriteSrcset(value, ctx) {
    return value
        .split(",")
        .map((part) => {
            const m = /^(\s*)(\S+)(.*)$/.exec(part);
            return m ? m[1] + rewriteUrl(m[2], ctx) + m[3] : part;
        })
        .join(",");
}

// 文本（JS / CSS / JSON / 内联脚本）中的绝对地址
const TEXT_ABS_RE = new RegExp(
    "(https?:)?//((?:[a-z0-9-]+\\.)*(?:wikipedia|wikimedia|wikimediafoundation|wikidata|wiktionary|wikibooks|wikiquote|wikisource|wikinews|wikiversity|wikivoyage|wikifunctions|mediawiki|toolforge|wmcloud|wmflabs)\\.org)",
    "gi"
);

// 文本中的根相对路径，只针对 MediaWiki 确定会用到的几个前缀，避免误伤
const TEXT_ROOTREL_RE = /(["'`(=])\/(w\/|wiki\/|api\/|static\/|rest\.php|index\.php|load\.php|api\.php)/g;

// wgScriptPath 这类恰好等于 "/w" 的值
const TEXT_SCRIPTPATH_RE = /(["'`])\/w(["'`])/g;

/**
 * 改写 JS / CSS / JSON / 内联脚本里的地址。
 * 这一步是修好 issue #1 的关键：startup 模块里的
 *   mw.loader.addSource({"local":"https://zh.wikipedia.org/w/load.php", ...})
 * 会被换成镜像地址，后续所有按需模块才不会去直连上游。
 */
function rewriteText(text, ctx) {
    let out = text.replace(TEXT_ABS_RE, (m, _scheme, host) => {
        const target = mirrorForHost(host, ctx.origin);
        return target || m;
    });
    if (ctx.prefix) {
        out = out.replace(TEXT_ROOTREL_RE, `$1${ctx.prefix}/$2`);
        out = out.replace(TEXT_SCRIPTPATH_RE, `$1${ctx.prefix}/w$2`);
    }
    return out;
}

// ===========================================================================
// 客户端补丁脚本
// ===========================================================================

/**
 * 内联注入到 <head> 最前面，同步执行，保证跑在 async 的 startup 模块之前。
 * 职责：把运行时才产生的地址（动态 <script>/<link>、fetch、XHR、sendBeacon…）
 * 也映射到镜像上，作为服务端改写的第二道保险。
 */
function clientPatch(ctx) {
    const cfg = JSON.stringify({
        p: ctx.prefix,
        family: FAMILY_HOST.source,
        lang: LANG_SHAPE.source,
        notLang: [...NOT_A_LANG],
        noPrefix: [...NO_PREFIX],
    });

    return `(function(){
if (window.__wikimirror__) return;
var C = ${cfg};
var FAMILY = new RegExp(C.family, "i");
var LANG = new RegExp(C.lang);
var NOT_LANG = {}, NO_PREFIX = {};
C.notLang.forEach(function(k){ NOT_LANG[k] = 1; });
C.noPrefix.forEach(function(k){ NO_PREFIX[k] = 1; });
var ORIGIN = location.origin;
var SKIP = /^(?:data|blob|javascript|mailto|tel|about|magnet|geo):/i;

function isLang(s){ return !!s && !NOT_LANG[s] && LANG.test(s); }

function forHost(host){
  var h = String(host).toLowerCase();
  if (h === "www.wikipedia.org" || h === "wikipedia.org") return ORIGIN;
  var m = /^([a-z0-9-]+)\\.wikipedia\\.org$/.exec(h);
  if (m && isLang(m[1])) return ORIGIN + "/" + m[1];
  if (FAMILY.test(h)) return ORIGIN + "/-/" + h;
  return null;
}

function map(raw){
  try {
    if (typeof raw !== "string") return raw;
    var s = raw.trim();
    if (!s || s.charAt(0) === "#" || SKIP.test(s)) return raw;
    if (s.slice(0, 2) === "//") {
      var h = s.slice(2).split(/[\\/?#]/)[0], t = forHost(h);
      return t ? t + s.slice(2 + h.length) : raw;
    }
    var abs = /^https?:\\/\\/([^\\/?#]+)/i.exec(s);
    if (abs) { var t2 = forHost(abs[1]); return t2 ? t2 + s.slice(abs[0].length) : raw; }
    if (s.charAt(0) === "/") {
      var i = s.indexOf("/", 1);
      var seg = (i < 0 ? s.slice(1) : s.slice(1, i)).toLowerCase();
      if (NO_PREFIX[seg] || isLang(seg)) return raw;
      return C.p + s;
    }
    return raw;
  } catch (e) { return raw; }
}

window.__wikimirror__ = { prefix: C.p, map: map };

// --- fetch ---------------------------------------------------------------
if (window.fetch) {
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    try {
      if (typeof input === "string") {
        input = map(input);
      } else if (input && typeof input === "object" && typeof input.url === "string") {
        var u = map(input.url);
        if (u !== input.url) input = new Request(u, input);
      }
    } catch (e) {}
    return _fetch.call(this, input, init);
  };
}

// --- XHR -----------------------------------------------------------------
if (window.XMLHttpRequest) {
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = map(url); } catch (e) {}
    return _open.apply(this, args);
  };
}

// --- sendBeacon / EventSource / WebSocket --------------------------------
if (navigator.sendBeacon) {
  var _beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function(url, data){ return _beacon(map(url), data); };
}
if (window.EventSource) {
  var _ES = window.EventSource;
  window.EventSource = function(url, cfg){ return new _ES(map(url), cfg); };
  window.EventSource.prototype = _ES.prototype;
}
if (window.WebSocket) {
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols){
    try {
      var s = String(url).replace(/^wss?:\\/\\//i, function(m){ return m.toLowerCase() === "ws://" ? "http://" : "https://"; });
      var mapped = map(s);
      if (mapped !== s) url = mapped.replace(/^http/i, "ws");
    } catch (e) {}
    return protocols === undefined ? new _WS(url) : new _WS(url, protocols);
  };
  window.WebSocket.prototype = _WS.prototype;
}

// --- 属性写入：mw.loader 用 document.createElement('script') + .src ------
var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, data: 1, formaction: 1,
                  "xlink:href": 1, "data-src": 1, "data-href": 1 };
var SET_ATTRS = { srcset: 1, imagesrcset: 1, "data-srcset": 1 };

function mapSrcset(v){
  return String(v).split(",").map(function(part){
    var m = /^(\\s*)(\\S+)(.*)$/.exec(part);
    return m ? m[1] + map(m[2]) + m[3] : part;
  }).join(",");
}

var _setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value){
  try {
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n]) value = map(value);
    else if (SET_ATTRS[n]) value = mapSrcset(value);
  } catch (e) {}
  return _setAttribute.call(this, name, value);
};

function hookProp(proto, prop, fn){
  try {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function(v){ d.set.call(this, fn(v)); }
    });
  } catch (e) {}
}

hookProp(window.HTMLScriptElement && HTMLScriptElement.prototype, "src", map);
hookProp(window.HTMLLinkElement && HTMLLinkElement.prototype, "href", map);
hookProp(window.HTMLImageElement && HTMLImageElement.prototype, "src", map);
hookProp(window.HTMLImageElement && HTMLImageElement.prototype, "srcset", mapSrcset);
hookProp(window.HTMLIFrameElement && HTMLIFrameElement.prototype, "src", map);
hookProp(window.HTMLMediaElement && HTMLMediaElement.prototype, "src", map);
hookProp(window.HTMLSourceElement && HTMLSourceElement.prototype, "src", map);
hookProp(window.HTMLSourceElement && HTMLSourceElement.prototype, "srcset", mapSrcset);
hookProp(window.HTMLFormElement && HTMLFormElement.prototype, "action", map);
hookProp(window.HTMLObjectElement && HTMLObjectElement.prototype, "data", map);

// --- 兜底：innerHTML 插入的节点不会走上面的钩子 --------------------------
if (window.MutationObserver) {
  var fix = function(el){
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    for (var a in URL_ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a), n = map(v);
      if (n !== v) _setAttribute.call(el, a, n);
    }
    for (var b in SET_ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(b)) continue;
      var v2 = el.getAttribute(b), n2 = mapSrcset(v2);
      if (n2 !== v2) _setAttribute.call(el, b, n2);
    }
  };
  new MutationObserver(function(records){
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        fix(node);
        if (node.querySelectorAll) {
          var kids = node.querySelectorAll("[src],[href],[action],[srcset],[data-src],[poster]");
          for (var k = 0; k < kids.length; k++) fix(kids[k]);
        }
      }
    }
  }).observe(document.documentElement || document, { childList: true, subtree: true });
}
})();`;
}

// ===========================================================================
// HTML 改写（流式）
// ===========================================================================

/** 元素 -> 需要改写的普通 URL 属性。 */
const URL_ATTRS = {
    a: ["href"],
    area: ["href"],
    link: ["href"],
    script: ["src"],
    img: ["src", "data-src", "longdesc"],
    source: ["src"],
    iframe: ["src"],
    frame: ["src"],
    form: ["action"],
    video: ["src", "poster"],
    audio: ["src"],
    track: ["src"],
    embed: ["src"],
    object: ["data"],
    input: ["formaction"],
    button: ["formaction"],
    use: ["href", "xlink:href"],
    image: ["href", "xlink:href"],
    blockquote: ["cite"],
    q: ["cite"],
    del: ["cite"],
    ins: ["cite"],
};

/** 元素 -> 需要改写的 srcset 类属性。 */
const SRCSET_ATTRS = {
    img: ["srcset", "data-srcset"],
    source: ["srcset", "data-srcset"],
    link: ["imagesrcset"],
};

/** <meta content="..."> 里带 URL 的那几个。 */
const META_URL_KEYS = new Set([
    "og:url",
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "og:audio",
    "og:video",
    "twitter:image",
    "twitter:image:src",
    "msapplication-tileimage",
]);

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function rewriteCss(css, ctx) {
    return rewriteText(css, ctx).replace(
        CSS_URL_RE,
        (m, q, u) => `url(${q}${rewriteUrl(u, ctx)}${q})`
    );
}

function buildHtmlRewriter(ctx) {
    const selector = (tags) => tags.join(",");
    const rw = new HTMLRewriter();

    // 1) 最前面注入客户端补丁（内联同步，早于任何其他脚本执行）
    rw.on("head", {
        element(el) {
            el.prepend(
                `<script>/*wikimirror*/${clientPatch(ctx)}</script>`,
                { html: true }
            );
        },
    });

    // 2) 普通 URL 属性
    for (const [tag, attrs] of Object.entries(URL_ATTRS)) {
        rw.on(tag, {
            element(el) {
                for (const attr of attrs) {
                    const v = el.getAttribute(attr);
                    if (v != null) el.setAttribute(attr, rewriteUrl(v, ctx));
                }
            },
        });
    }

    // 3) srcset
    for (const [tag, attrs] of Object.entries(SRCSET_ATTRS)) {
        rw.on(tag, {
            element(el) {
                for (const attr of attrs) {
                    const v = el.getAttribute(attr);
                    if (v != null) el.setAttribute(attr, rewriteSrcset(v, ctx));
                }
            },
        });
    }

    // 4) 我们改写了 JS/CSS 正文，SRI 摘要必然失配 —— 必须去掉 integrity，
    //    否则脚本/样式会被浏览器直接拒绝执行。
    rw.on(selector(["script[integrity]", "link[integrity]"]), {
        element(el) {
            el.removeAttribute("integrity");
        },
    });

    // 5) <meta content="...">
    rw.on("meta", {
        element(el) {
            const key = (
                el.getAttribute("property") ||
                el.getAttribute("name") ||
                ""
            ).toLowerCase();
            if (!META_URL_KEYS.has(key)) return;
            const v = el.getAttribute("content");
            if (v != null) el.setAttribute("content", rewriteUrl(v, ctx));
        },
    });

    // 6) style 属性里的 url()
    rw.on("[style]", {
        element(el) {
            const v = el.getAttribute("style");
            if (v && v.includes("url(")) {
                el.setAttribute("style", rewriteCss(v, ctx));
            }
        },
    });

    // 7) Parsoid 的 data-mw JSON
    rw.on("[data-mw]", {
        element(el) {
            const v = el.getAttribute("data-mw");
            if (v) el.setAttribute("data-mw", rewriteText(v, ctx));
        },
    });

    // 8) 内联 <script>：RLCONF / RLPAGEMODULES / RLQ 都在这里
    let scriptBuf = "";
    let inScript = false;
    rw.on("script", {
        element(el) {
            inScript = el.getAttribute("src") == null;
            scriptBuf = "";
        },
        text(chunk) {
            if (!inScript) return;
            scriptBuf += chunk.text;
            if (chunk.lastInTextNode) {
                chunk.replace(rewriteText(scriptBuf, ctx), { html: true });
                scriptBuf = "";
            } else {
                chunk.remove();
            }
        },
    });

    // 9) 内联 <style>
    let styleBuf = "";
    rw.on("style", {
        element() {
            styleBuf = "";
        },
        text(chunk) {
            styleBuf += chunk.text;
            if (chunk.lastInTextNode) {
                chunk.replace(rewriteCss(styleBuf, ctx), { html: true });
                styleBuf = "";
            } else {
                chunk.remove();
            }
        },
    });

    return rw;
}

// ===========================================================================
// 响应头处理
// ===========================================================================

/**
 * 上游 CSP 保留原有第三方白名单，但给每条取值型指令补上镜像自己需要的来源。
 * 因为所有维基资源现在都变成同源，'self' 就够；再放行 Cloudflare 的统计脚本，
 * 顺手消掉 issue #1 里那条 beacon.min.js 被拦的报错。
 */
const CSP_EXTRA = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "blob:",
    "data:",
    "https://static.cloudflareinsights.com",
];

const CSP_FETCH_DIRECTIVES = new Set([
    "default-src",
    "script-src",
    "script-src-elem",
    "script-src-attr",
    "style-src",
    "style-src-elem",
    "style-src-attr",
    "img-src",
    "font-src",
    "connect-src",
    "media-src",
    "object-src",
    "frame-src",
    "child-src",
    "worker-src",
    "manifest-src",
    "prefetch-src",
]);

function augmentCSP(headers) {
    for (const name of [
        "content-security-policy",
        "content-security-policy-report-only",
    ]) {
        const raw = headers.get(name);
        if (!raw) continue;

        const policies = raw.split(",").map((policy) =>
            policy
                .split(";")
                .map((d) => d.trim())
                .filter(Boolean)
                .filter((d) => {
                    const key = d.split(/\s+/)[0].toLowerCase();
                    // 上报端点指向 wikimedia，转发过来只会制造噪音
                    return key !== "report-uri" && key !== "report-to";
                })
                .map((d) => {
                    const tokens = d.split(/\s+/);
                    const key = tokens[0].toLowerCase();
                    if (!CSP_FETCH_DIRECTIVES.has(key)) return d;
                    if (key === "object-src") return d; // 保持 'none'
                    const have = new Set(tokens.slice(1));
                    const add = CSP_EXTRA.filter((t) => !have.has(t));
                    return add.length ? d + " " + add.join(" ") : d;
                })
                .join("; ")
        );

        headers.set(name, policies.join(", "));
    }

    // 这些上报头指向 wikimedia 的 intake，代理场景下没有意义
    headers.delete("reporting-endpoints");
    headers.delete("report-to");
    headers.delete("nel");
}

/** Link: <...>; rel=preload 里的地址同样指向上游，需要改写。 */
function rewriteLinkHeader(headers, ctx) {
    const link = headers.get("link");
    if (!link) return;
    headers.set(
        "link",
        link.replace(/<([^>]+)>/g, (m, u) => `<${rewriteUrl(u, ctx)}>`)
    );
}

// ===========================================================================
// Cookie：只放行读者的显示偏好
// ===========================================================================

/** 取出请求里被放行的 Cookie，排序后形如 ["mf_useformat=true"]。 */
function allowedCookiePairs(request) {
    const raw = request.headers.get("cookie");
    if (!raw) return [];
    return raw
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && COOKIE_ALLOWLIST.has(c.split("=")[0].trim()))
        .sort();
}

/**
 * 缓存键要带上偏好变体：移动版和桌面版是同一个 URL 的两份不同 HTML，
 * 不区分的话桌面访客会拿到别人缓存的移动版页面（反之亦然）。
 * 没有偏好 Cookie 的访客（绝大多数）仍然共用同一份缓存，不会造成碎片。
 */
function cacheKeyFor(url, request) {
    const pairs = allowedCookiePairs(request);
    if (!pairs.length) return new Request(url.toString(), { method: "GET" });
    const keyUrl = new URL(url.toString());
    keyUrl.searchParams.set("__wm_pref", pairs.join("&"));
    return new Request(keyUrl.toString(), { method: "GET" });
}

/** 逐条拆分 Set-Cookie。Expires 里含逗号，所以不能简单按逗号切。 */
function splitSetCookie(upstream) {
    if (typeof upstream.headers.getAll === "function") {
        return upstream.headers.getAll("set-cookie");
    }
    const raw = upstream.headers.get("set-cookie");
    if (!raw) return [];
    return raw.split(/,\s*(?=[A-Za-z0-9!#$%&'*+._`|~-]+=)/);
}

/** 只回传被放行的 Set-Cookie，并去掉 Domain= 让它只作用于镜像自身。 */
function filterSetCookie(upstream, headers) {
    headers.delete("set-cookie");
    for (const cookie of splitSetCookie(upstream)) {
        const name = cookie.split("=")[0].trim();
        if (!COOKIE_ALLOWLIST.has(name)) continue;
        headers.append("set-cookie", cookie.replace(/;\s*Domain=[^;]*/i, ""));
    }
}

function baseHeaders(upstream, ctx) {
    const h = new Headers(upstream.headers);

    // 我们要么改写正文、要么已由 CF 解压，这两个头一定不能留
    h.delete("content-encoding");
    h.delete("content-length");
    h.delete("transfer-encoding");

    // 只留读者的显示偏好，丢掉追踪与会话 Cookie
    filterSetCookie(upstream, h);

    // 偏好差异已并进缓存键，这里不要写 Vary: Cookie —— 否则任何无关 Cookie
    // （例如 __cf_bm）都会各自占一份缓存，命中率直接崩掉。
    h.set("Vary", "Accept-Encoding");

    augmentCSP(h);
    rewriteLinkHeader(h, ctx);

    const loc = h.get("location");
    if (loc) h.set("location", rewriteUrl(loc, ctx));

    h.set("Access-Control-Allow-Origin", "*");
    h.set("X-Wikimirror-Upstream", ctx.host);
    return h;
}

// ===========================================================================
// 主流程
// ===========================================================================

function cacheControlFor(contentType, isApi) {
    if (isApi) return "public, max-age=0, s-maxage=60";
    if (/^(?:image|video|audio|font)\//i.test(contentType))
        return "public, max-age=604800, s-maxage=2592000";
    if (/^text\/html/i.test(contentType)) return "public, max-age=0, s-maxage=300";
    return "public, max-age=3600, s-maxage=86400";
}

function forwardHeaders(request) {
    const out = new Headers();
    out.set("User-Agent", CFG.UA);
    for (const name of [
        "accept",
        "accept-language",
        "content-type",
        "range",
        "if-none-match",
        "if-modified-since",
    ]) {
        const v = request.headers.get(name);
        if (v) out.set(name, v);
    }
    // 上游按 Referer 做防盗链；给一个上游自身的地址最稳
    out.set("Referer", `https://${CFG.DEFAULT_LANG}.wikipedia.org/`);

    // 转发读者的显示偏好，否则「移动版视图」永远切不过去：
    // 该功能全靠 mf_useformat Cookie，上游收不到就一直给桌面版。
    const cookies = allowedCookiePairs(request);
    if (cookies.length) out.set("Cookie", cookies.join("; "));

    return out;
}

async function proxy(request, route, mirrorOrigin, cacheable, waitUntil) {
    const url = new URL(request.url);
    const ctx = { origin: mirrorOrigin, prefix: route.prefix, host: route.host };
    const upstream = `https://${route.host}${route.path}${url.search}`;

    const init = {
        method: request.method,
        headers: forwardHeaders(request),
        redirect: "manual", // 自己改写 Location，浏览器地址栏才不会跳出镜像
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
    }

    const resp = await fetch(upstream, init);

    // 304 / 无正文的状态直接回
    if (resp.status === 304 || resp.status === 204) {
        return new Response(null, {
            status: resp.status,
            headers: baseHeaders(resp, ctx),
        });
    }

    const contentType = resp.headers.get("content-type") || "";
    const headers = baseHeaders(resp, ctx);
    const isApi = /\/(?:api\.php|rest\.php|rest_v1)/.test(route.path);
    headers.set("Cache-Control", cacheControlFor(contentType, isApi));

    let out;
    if (/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        // 强制声明 UTF-8：注入的脚本会把上游的 <meta charset> 顶出前 1024 字节
        headers.set("Content-Type", "text/html; charset=UTF-8");
        out = buildHtmlRewriter(ctx).transform(
            new Response(resp.body, { status: resp.status, headers })
        );
    } else if (TEXTUAL.test(contentType)) {
        const len = Number(resp.headers.get("content-length") || 0);
        if (len > MAX_REWRITE_BYTES) {
            out = new Response(resp.body, { status: resp.status, headers });
        } else {
            const text = await resp.text();
            const body = /^text\/css/i.test(contentType)
                ? rewriteCss(text, ctx)
                : rewriteText(text, ctx);
            out = new Response(body, { status: resp.status, headers });
        }
    } else {
        // 图片 / 视频 / 字体等：流式转发，不碰正文
        out = new Response(resp.body, { status: resp.status, headers });
    }

    // 带 Set-Cookie 的响应不能进缓存（Cache API 会直接拒绝），
    // 而且那是「刚刚切换了偏好」的一次性响应，本来也不该被别人复用。
    if (
        cacheable &&
        out.status === 200 &&
        !out.headers.has("set-cookie") &&
        waitUntil
    ) {
        waitUntil(
            caches.default
                .put(cacheKeyFor(url, request), out.clone())
                .catch(() => {}) // 缓存失败不影响响应
        );
    }
    return out;
}

async function handleRequest(request, waitUntil) {
    const url = new URL(request.url);
    const mirrorOrigin = url.origin;

    if (
        CFG.ALLOWED_HOSTNAMES.length &&
        !CFG.ALLOWED_HOSTNAMES.includes(url.hostname)
    ) {
        return new Response("Invalid hostname", { status: 403 });
    }

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
                "Access-Control-Allow-Headers":
                    "Content-Type,Accept,Authorization,Api-User-Agent",
                "Access-Control-Max-Age": "86400",
                Vary: "Origin",
            },
        });
    }

    if (!["GET", "HEAD", "POST"].includes(request.method)) {
        return new Response("Method not allowed", { status: 405 });
    }

    // 语言集合还没就绪时后台拉一次，绝不阻塞当前请求（fail-open）
    if (LANG_SET === null && waitUntil) {
        waitUntil(refreshLangSet(mirrorOrigin));
    }

    // 调试端点：看看当前认可的语言集合
    if (url.pathname === "/-/langs.json") {
        return new Response(
            JSON.stringify(
                {
                    source: LANG_SET ? "sitematrix" : "shape-heuristic",
                    count: LANG_SET ? LANG_SET.size : null,
                    codes: LANG_SET ? [...LANG_SET].sort() : null,
                    shape: LANG_SHAPE.source,
                    notALanguage: [...NOT_A_LANG],
                },
                null,
                2
            ),
            {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "public, max-age=300",
                },
            }
        );
    }

    // 客户端补丁的独立副本（正常路径下是内联的，这里方便调试 / 排错）
    if (url.pathname === "/-/client.js") {
        const lang = url.searchParams.get("lang") || "";
        const prefix = isLangCode(lang) ? `/${lang}` : "";
        return new Response(
            clientPatch({ origin: mirrorOrigin, prefix, host: "" }),
            {
                headers: {
                    "Content-Type": "application/javascript; charset=utf-8",
                    "Cache-Control": "public, max-age=86400",
                },
            }
        );
    }

    let route = resolveRoute(url.pathname);
    let cacheable = request.method === "GET" && !request.headers.has("range");

    if (!route) {
        // 无前缀请求：可能是漏改的资源，或用户手输的 /wiki/Foo
        const prefix =
            prefixFromReferer(request, url.host) ??
            prefixFromAcceptLanguage(request) ??
            `/${CFG.DEFAULT_LANG}`;

        // 导航类请求给 301，让地址栏和后续相对解析都落到正确前缀上
        if (
            request.method === "GET" &&
            (request.headers.get("sec-fetch-mode") === "navigate" ||
                url.pathname.startsWith("/wiki/"))
        ) {
            return Response.redirect(
                `${mirrorOrigin}${prefix}${url.pathname}${url.search}`,
                301
            );
        }

        const host = hostFromPrefix(prefix);
        if (!host) return new Response("Not found", { status: 404 });
        route = { prefix, host, path: url.pathname };
        // 结果依赖 Referer，绝不能按 URL 缓存
        cacheable = false;
    }

    if (cacheable) {
        try {
            const hit = await caches.default.match(cacheKeyFor(url, request));
            if (hit) return hit;
        } catch (e) {
            /* 缓存不可用就直接回源 */
        }
    }

    try {
        return await proxy(request, route, mirrorOrigin, cacheable, waitUntil);
    } catch (err) {
        return new Response(
            `Upstream error for https://${route.host}${route.path}\n\n${err && err.message}`,
            {
                status: 502,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            }
        );
    }
}

addEventListener("fetch", (event) => {
    event.respondWith(
        handleRequest(event.request, event.waitUntil.bind(event))
    );
});
