# wikimirror
[简体中文](README-zh_CN.md)   [English](README.md)

使用CloudFlare Workers轻松搭建维基百科镜像。

## 简单搭建
创建一个CloudFlare Worker，将`main.js`的内容粘贴到编辑器中并部署。如果不使用默认的`workers.dev`域名，记得为你的域名添加路由。

**无需修改代码**——镜像会从请求本身推导自己的域名，不存在需要全局替换的常量。（如果想限制 Worker 只响应特定主机名，填写`CFG.ALLOWED_HOSTNAMES`即可。）

访问该域名即可使用。

## 路径结构
| 路径 | 上游 |
| --- | --- |
| `/` | `www.wikipedia.org`（门户） |
| `/<lang>/...` | `<lang>.wikipedia.org/...` |
| `/-/<hostname>/...` | `<hostname>/...`，仅限维基媒体家族域名 |
| `/image-proxy/...` | `upload.wikimedia.org/...`（兼容旧版） |
| `/-/langs.json` | 诊断用：当前认可的语言集合 |
| `/-/client.js` | 注入的客户端补丁的独立副本（便于排错） |

多语言版本通过URL路径访问，而非子域名。例如`https://你的域名/en`访问英文维基百科，`https://你的域名/zh`访问中文维基百科。

## 实现要点
- **不再打表列语言。** 语言码通过形状识别（`LANG_SHAPE`），已对全部 296 个维基百科语言码验证零漏判，包括`zh-min-nan`、`bat-smg`这类带连字符的历史码。MediaWiki 自己的根路径里只有`api`、`www`、`cdn-cgi`三个会撞上这个形状，显式排除即可。此外还会从 Meta 的`sitematrix`API 拉取权威语言集合，在边缘缓存一周、后台刷新、失败则放行，永不阻塞请求。
- **所有资源都走镜像。** 维基媒体家族的绝对地址在 HTML **以及** JavaScript / CSS / JSON 正文里都会被改写。这一点是关键：ResourceLoader 把模块源以硬编码绝对地址写在`startup`模块里（`mw.loader.addSource({"local":"https://<lang>.wikipedia.org/w/load.php"})`），如果不改写它，所有按需加载的模块都会去直连上游而失败——这正是「点击展开的内容加载不出来」的根因。
- **HTML 用`HTMLRewriter`流式改写**，不再对几 MB 的正文做几百遍`replaceAll`（这是旧版 Error 1102 CPU 超时的根因）。
- **客户端补丁内联在`<head>`最前面**，保证跑在 async 的 startup 模块之前。它负责映射运行时才产生的地址：动态`<script>`/`<link>`（`mw.loader`正是这样加载模块的）、`fetch`、`XMLHttpRequest`、`sendBeacon`、`EventSource`、`WebSocket`，以及各种带 URL 的属性写入。
- **CSP 是增补而非删除。** 保留上游的第三方白名单，补上镜像自身来源与 Cloudflare 统计脚本，并去掉指向维基媒体的上报端点。

## 已知问题
- 暂不支持登陆与编辑（CF 的 IP 已被上游封禁，且不代理会话）。
- 从第三方 CDN 加载的小工具仍会直连该 CDN；只有维基媒体家族域名会走代理。
- `data-mw-original-href`属性与 COinS 引文元数据会**故意**保留原始上游主机名，因为改写它们会破坏存档链接和书目记录。
