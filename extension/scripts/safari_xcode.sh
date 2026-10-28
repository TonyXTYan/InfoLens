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
