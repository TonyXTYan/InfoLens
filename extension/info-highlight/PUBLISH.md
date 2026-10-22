# Chrome Web Store 发布流程（Info Highlight）

流程与 Semantic Highlight 相同：打包 → 上传 → 提交审核。  
一次性 OAuth / API 凭证申请见 [../semantic-highlight/PUBLISH.md](../semantic-highlight/PUBLISH.md)。

**本次 API 只更新扩展包，不改商店 listing。** Listing 在 [Developer Dashboard](https://chrome.google.com/webstore/devconsole/) 手工维护。

商店页：https://chromewebstore.google.com/detail/gemajnklkebeikmfphiddpjfimahacdk

---

## 本机环境变量

仓库根目录 `.env`（已 gitignore，**勿提交**）：

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
CHROME_PUBLISHER_ID=...
CHROME_EXTENSION_ID_SEMANTIC_HIGHLIGHT=jnjglfjkbopeiodpcgmlhkfhldjfcdda
CHROME_EXTENSION_ID_INFO_HIGHLIGHT=gemajnklkebeikmfphiddpjfimahacdk

# Edge Add-ons Publish API（与 Chrome 并列；勿提交）
EDGE_CLIENT_ID=...
EDGE_API_KEY=...
EDGE_PRODUCT_ID=d8227511-1b3e-4d0a-a361-aee6791d851c
EDGE_STORE_ID=0RDCKDV93F5N
EDGE_CRX_ID=hdpmffhlpkjmlmbiepfgehfaapkllfco
```

本流程只用 `CHROME_EXTENSION_ID_INFO_HIGHLIGHT`。代理与连通自检同 Semantic 的 PUBLISH.md。

---

## 每次发布

### 1. 升版本

改 `extension/info-highlight/manifest.json` 的 `version`。

### 2. 打包

```bash
./extension/info-highlight/pack.sh
```

产出：`extension/dist/info-highlight-v<version>.zip`（`--release`，包内是空配置，不带本地 `config.js`）。

### 3. 上传 + 提交审核

也可直接用共用脚本（推荐）：

```bash
./extension/scripts/publish_store.sh --ext info-highlight --store chrome
./extension/scripts/publish_store.sh --ext info-highlight --store edge
./extension/scripts/publish_store.sh --ext info-highlight --store both
./extension/scripts/publish_store.sh --ext semantic-highlight   # 仅 Chrome
```

手工 curl 如下：


```bash
export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
set -a && source .env && set +a

ZIP="extension/dist/info-highlight-v<version>.zip"

ACCESS=$(curl -sS -x "$http_proxy" "https://oauth2.googleapis.com/token" \
  -d "client_secret=${GOOGLE_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${GOOGLE_REFRESH_TOKEN}&client_id=${GOOGLE_CLIENT_ID}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -sS -x "$http_proxy" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "x-goog-api-version: 2" \
  -X POST -T "$ZIP" \
  "https://chromewebstore.googleapis.com/upload/v2/publishers/${CHROME_PUBLISHER_ID}/items/${CHROME_EXTENSION_ID_INFO_HIGHLIGHT}:upload"

curl -sS -x "$http_proxy" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "x-goog-api-version: 2" \
  -H "Content-Type: application/json" \
  -X POST \
  "https://chromewebstore.googleapis.com/v2/publishers/${CHROME_PUBLISHER_ID}/items/${CHROME_EXTENSION_ID_INFO_HIGHLIGHT}:publish"
```

期望：上传 `"uploadState": "SUCCEEDED"`；发布 `"state": "PENDING_REVIEW"`。

### 4. 打 tag

```bash
git tag -a info-highlight-<version> -m "info-highlight-<version>"
```

Semantic Highlight 用 `semantic-highlight-<version>`。

---

## Edge Add-ons（包更新 API）

首次上架仍走 Partner Center 网页。扩展已在商店后，可用同一 release zip 走 Publish API 更新包（**不改 listing**）。

凭证与 Chrome 一样放在仓库根目录 `.env`（见上 `EDGE_*`）。官方说明：https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api  
请求头注意：`Authorization: ApiKey …` 与 **`X-ClientID`**（不是 `X-Client-ID`）。

### 一键脚本（推荐）

共用脚本：`extension/scripts/publish_store.sh`（一个脚本，用 `--ext` / `--store` 区分）。

先 `./extension/info-highlight/pack.sh`，再：

```bash
./extension/scripts/publish_store.sh --ext info-highlight --store chrome
./extension/scripts/publish_store.sh --ext info-highlight --store edge
./extension/scripts/publish_store.sh --ext info-highlight --store both
# 指定 zip
./extension/scripts/publish_store.sh --ext info-highlight --store edge extension/dist/info-highlight-v0.4.4.zip
```

脚本会 `source` 根目录 `.env`，并默认走本机代理 `http://127.0.0.1:7890`（与下文 curl 一致）。

当前身份（审核中）：Store ID `0RDCKDV93F5N`，CRX ID `hdpmffhlpkjmlmbiepfgehfaapkllfco`，Product ID 见 `.env` 的 `EDGE_PRODUCT_ID`。

