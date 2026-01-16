# wikimirror
[简体中文](README-zh_CN.md)   [English](README.md)

Build a Wikipedia mirror with CloudFlare Workers.

## How to Build
Create a CloudFlare Worker. Paste the contents of `main.js` into the editor and replace all occurrences of `wiki.davidx.top` with your assigned domain name. Click deploy and add a route for your domain name if it's not the default `workers.dev` domain.

Visit the domain name to use.

Note that multilingual versions are now accessed via URL paths instead of subdomains. For example, use `https://YOUR-DOMAIN-NAME/en` for English Wikipedia and `https://YOUR-DOMAIN-NAME/zh` for Chinese Wikipedia.

## Known Issues
- Doesn't support login/editing. (IP is banned and login has problems).
- May trigger Error 1102 (CPU Timeout). Seen once during operation but never seen after that.
