# wikimirror
Build a Wikipedia mirror with CloudFlare Workers.

## How to Build
Create **two** CloudFlare Workers. Put `image.js` into one and `main.js` into the other. Then, assign them with your own domain names.

Replace `wiki-img.davidx.top` with the domain name that you assigned for worker `image.js` and `wiki.davidx.top` for the one with `main.js`.

Enjoy!

## Known Issues
- Doesn't support login/editing. (IP is banned and login has problems).
- May trigger Error 1102 (CPU Timeout). Seen once during operation but never seen after that.
