# Info Highlight

Chrome MV3 extension: click the toolbar icon to heatmap surprisal on the current webpage or PDF. Click again to clear.

This is a separate plugin from Semantic Highlight (`extension/semantic-highlight/`). Shared page/PDF runtime sources live in `extension/shared/`. Build assembles them into a standalone extension artifact.

Store name/description live in `_locales/`. Build merges `extension/shared/_locales/` (local file access help) into the artifact; this plugin's keys win on conflict.

Toolbar icon is a 4-row red mosaic (`icons/render-icons.py`); same RGB as the heatmap. Analyzing lights the 8 tiles in reading order against the current batch (Continue starts over).

## Load

```bash
python3 extension/scripts/build_extension.py info-highlight
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/dist/info-highlight/`。
普通 http(s) 文章或 PDF → 点工具栏图标。再点清除。
分析按段推进，一段回来再发下一段。本机请求在进藏页前排队，同时只算一段；多个标签在等时先算当前窗口正在看的那个。云端请求不进这个队列。本地引擎按「上一段结束」闲置约 10 秒卸载，不绑整轮是否跑完。

本机 WebGPU 分析依赖 `@huggingface/transformers`（构建时拷进包，官方非压缩 ORT，不进 git）：

```bash
cd extension/info-highlight && npm install
```

clone 后至少要装一次，再 `build_extension.py`。选项里可改「自动 / 仅本机 / 仅云端」；本机模型需先在「本地模型初始化」里同意下载。仅本机失败不会改走云端。

右键「Analyze this page」等同点工具栏；「Force analyze this page」跳过缓存再跑（已有高亮会清掉重画）；正在分析时用系统提示说明，等结束后再点。「Always analyze example.com」→ 当场申请该 hostname 的 host 权限（子域各算各的），之后该站前台标签在 `complete` 后自动分析一次。动态跟踪开着：马上跑，晚到正文由跟踪补画。关掉：马上跑；第一段结束时正文变了就作废重来；若整轮 1 秒内结束，等到 1 秒再对一次（补查结束前图标保持分析中。页内已在跑或已画好就不动它）；补查结束后 DOM 再变不自动重抽，映不回的高亮丢掉，要按新正文就点工具栏清掉再点一次。点图标可在加载中注入，抽正文和分析等 `complete`。
PDF 与 `file:` 不进这条路。名单在选项页 Auto analyze 里增删（删时连权限一起撤），那里还可填 `*.example.com` 或 `*`；右键菜单只管精确 hostname，通配项去选项页管。

受限页（`chrome://`、Web Store、…）无操作。无键盘快捷键。

`file:` PDF 须在扩展详情页打开 “Allow access to file URLs”。

本地调试改 gitignore 的 `config.js`（例如 `modalDebug: true`，或 `apiBase: 'https://…'` 指向沙箱门面），再构建。没有这份就用空配置。上架构建带 `--release`，写入空配置，不带本地这份。

## Safari (macOS)

Same source, separate build. `--target safari` writes `extension/dist/info-highlight-safari/`; the Chrome build is unchanged.

```bash
python3 extension/scripts/build_extension.py info-highlight --target safari
```

**Try it without Xcode (recent Safari, e.g. 26):** Safari → Settings → Developer → tick "Allow unsigned extensions" (resets when Safari quits) → "Add Temporary Extension…" → pick `extension/dist/info-highlight-safari/`. Safari drops temporary extensions after 24 h or on quit.

**Ship it:** Safari only installs extensions bundled in an app.
- On a Mac with Xcode, run `./extension/scripts/safari_xcode.sh --bundle-identifier com.you.InfoHighlight`. It generates `extension/dist/safari-xcode/info-highlight/`; build and run the macOS scheme there. The project references the build folder, so later changes only need this script again (or the build command) plus Build in Xcode.
- Without a Mac: the `Safari app (macOS)` GitHub Actions workflow runs on every push touching `extension/` (or by hand). It builds an ad-hoc signed `Info Highlight.app` and uploads it as the run's `info-highlight-safari` artifact. After unzipping, run `xattr -dr com.apple.quarantine "Info Highlight.app"` and open the app once. Then turn on "Allow unsigned extensions" in Safari, which resets each time Safari quits. Set the repo variable `SAFARI_BUNDLE_ID` to change the bundle ID.
- For the App Store, App Store Connect's web packager takes the zip from `./pack-safari.sh` (`extension/dist/info-highlight-safari-v<version>.zip`). This needs an Apple Developer account.

What the Safari build changes (everything else is the Chrome code as-is):
- **Background:** Safari runs it as a background page, not a service worker. `background.scripts` is `safari/background-env.js`, then every `importScripts('…');` line of `background.js` in order, then `background.js`. Only whole-line string-literal `importScripts` is allowed; the build fails otherwise.
- **On-device engine:** Safari has no `chrome.offscreen`. `safari/background-env.js` mounts `local/offscreen.html` as an iframe in the background page instead. Messages are unchanged, and removing the iframe frees the model.
- **Permissions:** drops `offscreen` and `file:///*`. `file:` pages count as protected, because Safari extensions can't read them.
- **Versions:** the extension needs Safari 17 or later, and the app wrapping it needs macOS 12 or later. `safari_xcode.sh` lowers the Xcode project's deployment target to 12.0, because the packager defaults to the build machine's macOS. It also sets the app's bundle ID to the extension's prefix, so any `--bundle-identifier` works.

Not yet checked on a real Mac:
- WebGPU with `shader-f16` inside the background-page iframe. If it is missing, Auto falls back to cloud, as on unsupported Chrome.
- Whether Safari keeps the non-persistent background page alive through a long model download or analysis.
- PDF tabs.
- The "Always analyze" host-permission prompt.

The "rate us" link still points to the Chrome Web Store.

### iOS / iPadOS: postponed

The Safari builds are macOS only for now: `safari_xcode.sh` passes `--macos-only` and CI builds only the Mac app. There are two reasons.

- **The background script would crash.** Safari on iOS/iPadOS has no `contextMenus` API, and `background.js` registers a context-menu listener at startup. iOS also lacks `windows.create` and `windows.update`, which all its popup windows use (welcome, model init, notices).
- **On-device analysis can't run inside the extension.** On iOS the extension's native process is reportedly capped at about 80 MB; that figure comes from 2021 reports and should be retested. The increased-memory entitlement doesn't apply to extensions. Safari extension pages also crash at a few hundred MB. Our smallest suitable model is roughly 150–570 MB. Apple's Foundation Models can't fill the gap, because they only generate text and give no per-token probabilities.

Plan when this resumes:
1. **Cloud only.** Guard the `contextMenus` calls so the background starts on iOS, and replace the popup windows with tabs. Run the packager without `--macos-only`, which adds iPhone/iPad targets. Analysis uses the cloud API.
2. **On device, in the companion app.**
   - Load the model in the app, which isn't bound by the extension's memory cap. Use MLX Swift with Qwen3‑0.6B 4-bit or Gemma‑3‑270M on iOS 26, or Core AI's Qwen3 export on iOS 27. Either way the app needs the increased-memory entitlement.
   - The extension hands text to the app through an App Group folder, using `browser.runtime.sendNativeMessage` from the background page; content scripts can't call it on iOS.
   - The user has to open the app to run analysis, because the extension can't launch it in the background. Cloud stays the fallback.

## Test and package

```bash
npm test
./pack.sh
```

The package command builds with `--release`（空 `config.js`）, runs tests, and writes `extension/dist/info-highlight-v<version>.zip`.

上传与提交审核见 [PUBLISH.md](./PUBLISH.md)（Chrome Web Store API）。
