# wikimirror
[简体中文](README-zh_CN.md)   [English](README.md)
使用CloudFlare轻松搭建维基百科镜像。

## 简单搭建
创建两个CF Workers并分别贴入`image.js`和`main.js`。然后，分配自己的域名。

将代码中的`wiki-img.davidx.top`和`wiki.davidx.top`分别替换为`image.js`和`main.js`对应的域名。

访问`main.js`对应的域名即可使用。多语言版本由原版的域名前缀改为了URL路径，即`https://YOUR-DOMAIN-NAME/zh`的形式。

## 已知问题
- 暂不支持登陆与编辑。CF的IP已被封禁，且登陆功能异常。
- 有时会报错1102，但目前只遇到过一次。
