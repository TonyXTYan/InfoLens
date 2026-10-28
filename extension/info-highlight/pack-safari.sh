#!/bin/bash
# Safari 版 zip：Safari 26「添加临时扩展…」或 App Store Connect 网页版打包器都直接吃这个 zip。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

npm test

version="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
python3 ../scripts/build_extension.py info-highlight --target safari --release
python3 ../scripts/package_extension.py ../dist/info-highlight-safari "../dist/info-highlight-safari-v${version}.zip"
