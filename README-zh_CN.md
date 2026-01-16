# wikimirror
[简体中文](README-zh_CN.md)   [English](README.md)

使用CloudFlare Workers轻松搭建维基百科镜像。

## 简单搭建
创建一个CloudFlare Worker。将`main.js`的内容粘贴到编辑器中，并将所有出现的`wiki.davidx.top`替换为你分配的域名。点击部署，并为你的域名添加路由（如果不使用默认的`workers.dev`域名）。

访问该域名即可使用。

注意，多语言版本现通过URL路径访问，而非子域名。例如，使用`https://YOUR-DOMAIN-NAME/en`访问英文维基百科，使用`https://YOUR-DOMAIN-NAME/zh`访问中文维基百科。

## 已知问题
- 暂不支持登陆与编辑。CF的IP已被封禁，且登陆功能异常。
- 有时会报错1102，但目前只遇到过一次。
