# BUILD · 编译与打包

## English

### Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 (the build targets `win` `x64` only) |
| Node.js | 18 LTS or newer (developed on Node 22/24) |
| npm | 9 or newer |
| Network | First install/build downloads Electron (~110 MB) and electron-builder helper tools (NSIS, winCodeSign) |
| Disk | ~1.5 GB for `node_modules` + build cache |

No other toolchain is needed: no Visual Studio, no Python, no global CLI.

### Install dependencies

```bash
npm install
```

Exact versions are pinned: `electron@44.9.1`, `electron-builder@24.13.3`, plus the single runtime
dependency `yauzl@3.2.0`.

> **If your network cannot reach GitHub releases** (common in mainland China), set a mirror before
> both install and build, otherwise `npm install` may silently skip the Electron binary and
> `npm run build` fails with `Bad Gateway` while downloading `electron-v44.9.1-win32-x64.zip`:
>
> ```bash
> # bash / git-bash
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> # cmd.exe
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> ```
>
> This was verified: the same source tree builds successfully with the mirror and fails without it
> on a network that blocks GitHub downloads.

### Run from source

```bash
npm start
```

Notes:

- Running from source uses the project folder as the data folder: `characters/`, `角色导入/`,
  and `assets/models/` are read from here. The repository ships `characters/` empty on purpose.
- Add `--no-ai` to force-disable the optional AI dialogue feature while testing:
  `npm start -- --no-ai`
- `--data-dir=<path>` runs against an isolated data folder (useful for empty-state testing).

### Build the Windows binaries

```bash
npm run build
```

Output (`dist/`):

| File | Meaning |
|---|---|
| `XXL Desktop Pet.exe` | Portable single-file build |
| `XXL Desktop Pet Setup <version>.exe` | NSIS installer |
| `win-unpacked/` | Unpacked build (debugging) |

`asar` is intentionally **disabled**: the renderer shell (`renderer.html`, `renderer.js`, …) is
copied into the writable data folder at startup so that installed characters and the HTML share one
relative root. Do not enable `asar` without reworking `runtime-paths.js`.

### Icons

The public build uses an original geometric paw, not game artwork. `npm run icons:neutral` reproduces app and tray icons using only Node.js; `build/neutral-icon.png` is its preview.

```bash
npm run icons -- path\to\source.ico     # or a .png
```

Regenerates `build/icon.ico` (EXE/installer) and `assets/tray.ico` (tray). Source images below
86 px will look soft when Windows scales them up; use 256 px or larger.

### Project layout

```
main.js                 Electron main process: window, tray, IPC, data-folder resolution
runtime-paths.js        program folder vs. writable data folder, shell sync
preload.js              contextBridge API exposed to the renderer
renderer.html/.js/.css  UI: settings panel, empty state, hit testing, input handling
config-loader.js        scans characters/<id>/ and merges configs
character-package.js    character ZIP format rules and validation
character-importer.js   ZIP install queue: checks, atomic install, rollback, inbox watcher
ai-dialogue.js / ai/    optional DeepSeek dialogue (off by default)
assets/                 Spine runtime, layout helper, dialogue bubble (no game assets)
build/afterpack.js      writes icon + version info into the EXE after packaging
tools/build_icon_assets.js  icon regeneration
characters/             empty; add <id>/ folders to load characters
```

### Adding characters while developing

Put a character folder under `characters/<id>/` with `character.json`, `assets.json`,
`layout.json`, optional `dialogues.json` / `persona.json`, and the resources under
`assets/models/...`. Restart the app. See `docs/CHARACTER_PACK_FORMAT.md` for the packaged ZIP
format used by the importer.

### Troubleshooting the build

- **`[afterPack] 警告：没找到 rcedit-x64.exe`** — the EXE is built but keeps the default Electron
  icon. Run one build with `signAndEditExecutable: true` (after a successful `winCodeSign`
  extraction) or copy `rcedit-x64.exe` into the electron-builder cache. This affects the icon only,
  never runtime behaviour.
- **`Cannot compute electron version`** — `electron` must be installed in `node_modules`
  (i.e. run `npm install` first).
- **SmartScreen warning** — expected: builds are unsigned.
- **`Error: Cannot create symbolic link`** — that is why `signAndEditExecutable` is disabled and the
  icon/version strings are written by `build/afterpack.js` instead.

---

## 中文

### 环境要求

| | |
|---|---|
| 系统 | Windows 10/11 x64（只构建 `win x64`） |
| Node.js | 18 LTS 及以上（开发用 22/24） |
| npm | 9 及以上 |
| 网络 | 首次安装/构建需要下载 Electron（约 110 MB）和 electron-builder 辅助工具（NSIS、winCodeSign） |
| 磁盘 | `node_modules` 与构建缓存合计约 1.5 GB |

不需要 Visual Studio、Python 或任何全局命令行工具。

### 安装依赖

```bash
npm install
```

版本已固定：`electron@44.9.1`、`electron-builder@24.13.3`，运行时依赖只有 `yauzl@3.2.0`。

> **如果访问不了 GitHub release**（国内常见），装依赖和打包前都要设镜像，否则 `npm install`
> 可能静默跳过 Electron 二进制，随后 `npm run build` 在下载 `electron-v44.9.1-win32-x64.zip`
> 时报 `Bad Gateway`：
>
> ```bash
> # bash / git-bash
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> # cmd.exe
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> ```
>
> 这一条是实测结论：同一份源码在设了镜像的机器上打包成功，不设则在同一网络下失败。

### 源码运行

```bash
npm start
```

- 源码运行时，**项目目录就是数据目录**：`characters/`、`角色导入/`、`assets/models/` 都读这里。
  仓库里 `characters/` 故意留空。
- 测试时可加 `--no-ai` 强制关闭可选的 AI 台词：`npm start -- --no-ai`
- `--data-dir=<路径>` 可指定独立数据目录（用来测空角色状态）。

### 打包 Windows 产物

```bash
npm run build
```

产物在 `dist/`：`XXL Desktop Pet.exe`（便携版）、`XXL Desktop Pet Setup <版本>.exe`（安装版）、
`win-unpacked/`（免安装目录，调试用）。

`asar` 是**故意关闭**的：启动时会把 `renderer.html / renderer.js` 等外壳文件同步到可写数据目录，
让"导入的角色素材"和 HTML 处在同一个相对根下。不要在不改 `runtime-paths.js` 的情况下打开 asar。

### 图标

公开版使用原创几何爪印，不含游戏美术。`npm run icons:neutral` 仅用Node.js即可复现EXE、窗口和托盘图标；`build/neutral-icon.png` 为预览。

```bash
npm run icons -- 源图路径.ico     # 或 .png
```

会重新生成 `build/icon.ico`（EXE/安装包）和 `assets/tray.ico`（托盘）。源图小于 86px 时放大后会糊，
建议用 256px 以上。

### 目录结构

见上方英文段的表格（同一套文件）。

### 构建问题排查

- **`[afterPack] 警告：没找到 rcedit-x64.exe`**：EXE 能正常跑，只是保留 Electron 默认图标。
  先成功解压一次 `winCodeSign`，或把 `rcedit-x64.exe` 放进 electron-builder 缓存即可。
- **`Cannot compute electron version`**：先 `npm install`，让 `node_modules/electron` 存在。
- **SmartScreen 提示**：未签名，属正常。
- **`Cannot create symbolic link`**：这就是关掉 `signAndEditExecutable`、改由 `build/afterpack.js`
  写图标和版本信息的原因。
