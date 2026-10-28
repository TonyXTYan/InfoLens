#!/bin/bash
# 仅限 Mac + Xcode：把 Safari 构建包成 macOS App 的 Xcode 工程（dist/safari-xcode/<name>）。
# 工程引用 dist/<name>-safari 里的文件而非拷贝；之后改代码只需重跑本脚本（或 build_extension.py --target safari），再在 Xcode 里 Build。
# 工程已存在时不重新生成，免得冲掉签名设置；要重建就加 --force。其余参数原样交给打包器，例如：
#   ./extension/scripts/safari_xcode.sh info-highlight --bundle-identifier com.example.InfoHighlight
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

name="info-highlight"
if [[ $# -gt 0 && "$1" != -* ]]; then
  name="$1"
  shift
fi
out="dist/${name}-safari"
project="dist/safari-xcode/${name}"

python3 scripts/build_extension.py "$name" --target safari
if [[ -d "$project" && " $* " != *" --force "* ]]; then
  echo "safari: $project 已存在，扩展文件已更新；在 Xcode 里 Build 即可（重建工程加 --force）"
  exit 0
fi
app_name="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['extName']['message'])" "$out/_locales/en/messages.json")"
# Xcode 26 起改名 packager，Xcode 16 及以前叫 converter，参数相同
tool=safari-web-extension-packager
xcrun --find "$tool" >/dev/null 2>&1 || tool=safari-web-extension-converter
# iOS 版 Safari 没有 contextMenus / windows，背景页起不来，先只出 macOS
xcrun "$tool" "$out" \
  --project-location "$project" \
  --app-name "$app_name" \
  --swift --macos-only --no-open "$@"

# 打包器按 App 名另拼 App 的 bundle ID（空格转连字符），与扩展的 <ID>.Extension 对不上时 Xcode 拒绝嵌入；以扩展的为准。
# 部署目标默认是本机 SDK 版本，压到 Safari 17 能装的最老 macOS。
pbxproj="$(find "$project" -name project.pbxproj | head -1)"
python3 - "$pbxproj" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
ids = set(re.findall(r'PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;', text))
ext = [i for i in ids if i.endswith(".Extension")]
if len(ext) != 1:
    sys.exit(f"safari: 找不到唯一的扩展 bundle ID：{sorted(ids)}")
app = ext[0].removesuffix(".Extension")
for other in ids - {ext[0], app}:
    text = re.sub(rf'PRODUCT_BUNDLE_IDENTIFIER = "?{re.escape(other)}"?;', f'PRODUCT_BUNDLE_IDENTIFIER = "{app}";', text)
text = re.sub(r'MACOSX_DEPLOYMENT_TARGET = [0-9.]+;', 'MACOSX_DEPLOYMENT_TARGET = 12.0;', text)
open(path, "w", encoding="utf-8").write(text)
print(f"safari: App {app} / 扩展 {ext[0]}，macOS 12.0+")
PY
