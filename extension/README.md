# 浏览器插件

**Chrome 加载的是 `dist/`，不是源码目录。**  
改 `info-highlight/`、`semantic-highlight/` 或 `shared/` 之后，让人测之前必须先构建，否则扩展里点重新加载也是旧产物。

```bash
python3 extension/scripts/build_extension.py
```

不带参数会构建 info-highlight 和 semantic-highlight。只改其中一个时带上名字。

选项「新增」蓝点：改对应插件的 `options-catalog.js`（步骤写在文件头注释里）。

| 插件 | Chrome Web Store ID | 商店页 |
|------|---------------------|--------|
| [Info Highlight](./info-highlight/README.md) | `gemajnklkebeikmfphiddpjfimahacdk` | [打开](https://chromewebstore.google.com/detail/gemajnklkebeikmfphiddpjfimahacdk) |
| [Semantic Highlight](./semantic-highlight/README.md) | `jnjglfjkbopeiodpcgmlhkfhldjfcdda` | [打开](https://chromewebstore.google.com/detail/jnjglfjkbopeiodpcgmlhkfhldjfcdda) |

上架：各自目录下的 `PUBLISH.md`；本机 `.env` 里用 `CHROME_EXTENSION_ID_INFO_HIGHLIGHT` / `CHROME_EXTENSION_ID_SEMANTIC_HIGHLIGHT`（Publisher 共用）。

