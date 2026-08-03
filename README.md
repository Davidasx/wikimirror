# wikimirror
[简体中文](README-zh_CN.md)   [English](README.md)

Build a Wikipedia mirror with CloudFlare Workers.

## How to Build
Create a CloudFlare Worker, paste the contents of `main.js` into the editor and deploy. Add a route for your domain if you're not using the default `workers.dev` domain.

**No editing required** — the mirror derives its own origin from the incoming request, so there is nothing to find-and-replace. (If you want to restrict which hostnames the Worker answers on, fill in `CFG.ALLOWED_HOSTNAMES`.)

Visit the domain name to use.

## URL Layout
| Path | Upstream |
| --- | --- |
| `/` | `www.wikipedia.org` (portal) |
| `/<lang>/...` | `<lang>.wikipedia.org/...` |
| `/-/<hostname>/...` | `<hostname>/...`, restricted to Wikimedia-family domains |
| `/image-proxy/...` | `upload.wikimedia.org/...` (legacy alias) |
| `/-/langs.json` | Diagnostics: the language set currently recognised |
| `/-/client.js` | Standalone copy of the injected client patch (for debugging) |

Multilingual versions are accessed via URL paths instead of subdomains, e.g. `https://YOUR-DOMAIN/en` for English and `https://YOUR-DOMAIN/zh` for Chinese.

## How It Works
- **No hardcoded language list.** Language codes are recognised by shape (`LANG_SHAPE`), which matches all 296 Wikipedia language codes including hyphenated legacy ones like `zh-min-nan` and `bat-smg`. Only three MediaWiki root paths collide with that shape (`api`, `www`, `cdn-cgi`), so they're excluded explicitly. An authoritative code set is fetched from Meta's `sitematrix` API, cached at the edge for a week, refreshed in the background, and fails open — so it never blocks a request.
- **Everything goes through the mirror.** All Wikimedia-family absolute URLs are mapped to mirror paths, in HTML *and* in JavaScript/CSS/JSON payloads. This matters because ResourceLoader ships its module source as a hardcoded absolute URL inside the `startup` module (`mw.loader.addSource({"local":"https://<lang>.wikipedia.org/w/load.php"})`); if that isn't rewritten, every lazily-loaded module is fetched straight from upstream and fails.
- **Streaming HTML rewriting** via `HTMLRewriter` instead of running hundreds of `replaceAll` passes over a multi-megabyte document.
- **A client-side patch** is inlined at the very top of `<head>` so it runs before the `async` startup module. It maps URLs created at runtime: dynamic `<script>`/`<link>` (which is exactly how `mw.loader` fetches modules), `fetch`, `XMLHttpRequest`, `sendBeacon`, `EventSource`, `WebSocket`, and URL-bearing attribute writes.
- **CSP is augmented, not deleted.** Upstream's third-party allowlist is preserved; the mirror's own origin and Cloudflare's analytics beacon are added, and the Wikimedia reporting endpoints are stripped.

## Known Issues
- Doesn't support login/editing (Cloudflare IPs are blocked upstream, and sessions aren't proxied).
- Gadgets that load from third-party CDNs still reach those CDNs directly; only Wikimedia-family domains are proxied.
- `data-mw-original-href` attributes and COinS citation metadata deliberately keep the original upstream hostnames, since rewriting them would corrupt archive links and bibliographic records.
