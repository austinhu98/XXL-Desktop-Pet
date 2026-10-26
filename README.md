# XXL Desktop Pet · XXL 桌面宠物

[Download v1.0.0 · 下载Windows版](https://github.com/austinhu98/XXL-Desktop-Pet/releases/download/v1.0.0/XXL-Desktop-Pet-v1.0.0-win64.zip) · [Releases · 版本记录](https://github.com/austinhu98/XXL-Desktop-Pet/releases)

<img width="1303" height="760" alt="bw" src="https://github.com/user-attachments/assets/20a60a89-7b2b-4f8a-afd9-e95b2ceda007" />


Unofficial Windows desktop pet **loader** for the game **XXL WOOFIA** (中文：《XXL猛汉特区》).
It renders Spine skeletal animations on a transparent always-on-top window and lets you install
character packs you obtained legally as ZIP files.

**This repository contains no game assets.** No sprites, skeletons, atlases, audio, or character
ZIP packs are included. You must supply your own character packs.

> 本项目是一款针对《XXL猛汉特区》（XXL WOOFIA）的**非官方** Windows 桌面宠物**加载器**。
> **仓库不包含任何游戏素材**（贴图 / 骨骼 / 图集 / 音频 / 角色 ZIP），角色包需你自行准备。

---

## English

### 1. What this is

`XXL Desktop Pet` is a standalone Electron application that acts as a **Spine runtime host** for
desktop pets. The program itself ships empty: on first launch it shows a friendly "no character
installed yet" card, and you add characters by importing a ZIP pack. Character packs are data
only (skeleton, atlas, images, layout, dialogue); the loader code is identical for every character.

- Software name: **XXL Desktop Pet**
- Target game: **XXL WOOFIA** (《XXL猛汉特区》) — unofficial, fan-made
- Not affiliated with, endorsed by, or supported by the game's developer or publisher.

### 2. Features

| | |
|---|---|
| Spine rendering | Compatible Spine skeletons (binary `.skel` or JSON), skins, attachment timelines, premultiplied alpha; export/runtime versions must match |
| Multi-character | Load many character folders, switch at runtime, unload by deleting the folder |
| Costumes & states | Per-character model lists (SFW / adult), faces, armor/undress toggles, still-image CG sets |
| Placement | Per-costume layout profiles, global zoom and X/Y adjustment, window auto-resize |
| Settings panel | Character/model/mode selection, size, always-on-top, auto-switch, hardware acceleration, click-through, quit |
| Tray | Tray icon opens settings; menu offers reload and quit; recovery menu if the window becomes unclickable |
| ZIP import | Import from the settings panel, or drop a ZIP into the inbox folder (watched, no restart needed) |
| Empty state | Starts fine with zero characters, shows an install guide instead of a blank window |
| AI dialogue (optional) | Bring your own DeepSeek API key; **off by default**, falls back to bundled-per-pack local lines |
| Click-through | Transparent areas pass clicks to the desktop; global hotkey toggles full click-through |

### 3. Windows requirements

- Windows 10 or Windows 11, **x64**
- No Node.js, no developer tools, no command line needed for the EXE
- ~400 MB free disk (the app is ~110 MB; characters add 30–60 MB each)
- A GPU/driver that supports transparent Chromium windows (defaults are safe: hardware
  acceleration is **off** unless you enable it in settings)

### 4. Download and install

The v1.0.0 download is `XXL-Desktop-Pet-v1.0.0-win64.zip`. Extract it and run `XXL Desktop Pet.exe`. It contains the portable app, instructions and license notices, without character packs. An installer is not included in this release; developers can build one from source.

| File | Use |
|---|---|
| `XXL Desktop Pet.exe` | **Portable.** Double-click and it runs. Nothing is installed. |
| `XXL Desktop Pet Setup <version>.exe` | Optional source-build output, not included in this release. |

Notes:

- The builds are **unsigned**. Windows SmartScreen may show "Unknown publisher" on first run:
  click **More info → Run anyway**.
- The portable build unpacks itself to a temp folder on each start; that is normal.
- Character data is **not** stored next to the EXE; see §7 for the data folder.

### 5. Using the pet

- **Drag** the character to move it.
- **Click** the character to trigger an action (per-character rules).
- **Right-click** the window (or click the tray icon) to open settings.
- Settings → **Exit desktop pet** closes the program. With no character installed, the empty-state
  card has its own **Exit** button.
- Global hotkeys (a fallback is registered automatically if they are occupied):
  - `Ctrl+Shift+P` — toggle full click-through (when enabled, clicks go to the desktop)
  - `Ctrl+Shift+Q` — quit
  - If these are taken: `Ctrl+Alt+Shift+P` / `Ctrl+Alt+Shift+Q`, then `Ctrl+Alt+Shift+F1…F12` / `Ctrl+Alt+F1…F12`

### 6. Installing a character ZIP

**Method A — from the app**

1. Open settings (right-click the window or left-click the tray icon).
2. Click **导入角色 / Import character**.
3. Pick a `.zip` character pack. It is validated, installed, then the character list refreshes and
   the new character is loaded immediately.

**Method B — inbox folder**

1. In settings, click **打开导入文件夹 / Open import folder**.
2. Copy the `.zip` into that folder. **Do not unzip it.**
3. The app detects the file, installs it automatically (a 15 s polling fallback also runs), and the
   character shows up. Works even if you drop the ZIP while the app is closed.

Import rules: the ZIP is validated (manifest, SHA-256, CRC, path traversal, size limits) and
installed atomically. Existing characters are never overwritten — a duplicate ID is skipped with a
message. A corrupt or conflicting pack is rejected and rolled back.

### 7. Where characters live (auto-discovery)

The loader scans a writable **data folder** at startup and every time an import finishes:

```
%APPDATA%\XXL Desktop Pet\        <- default data folder (packaged build)
├─ characters\<id>\               <- one folder per installed character
├─ assets\models\...              <- resources unpacked from ZIP packs
├─ 角色导入\                       <- inbox: drop ZIPs here
└─ renderer.*, assets\*.js|css     <- runtime shell copy (do not edit)
```

- **Manual install / uninstall = add or delete a folder** under `characters\` (delete the whole
  folder to uninstall), then restart the app.
- Portable build only: create a `data` folder next to the EXE and character data is stored there instead of `%APPDATA%`.
- Advanced: `--data-dir=<path>` or the `XXL_PET_DATA` environment variable overrides everything.
- The settings panel always shows the resolved data folder, so you never have to guess.

### 8. Building from source

See **[BUILD.md](BUILD.md)**. Short version:

```bash
npm install
npm start          # run from source
npm run build      # produce dist/XXL Desktop Pet.exe (portable) + installer
```

### 9. FAQ / troubleshooting

**The window is invisible after launch.** A character may not be installed yet — the empty-state
card should be in the middle of the screen. If even that is missing, start with `--data-dir=<new
empty folder>` to rule out a broken character folder.

**Double-click does nothing.** Check the tray: the app may be running with the window off-screen.
Use the tray menu → *Open settings*. Antivirus may also have blocked the unsigned EXE.

**Import says "already installed".** A character with the same ID exists. Uninstall means deleting
`characters\<id>` in the data folder; the loader never deletes it for you.

**Import rejected.** The pack is invalid, corrupt, or conflicts with an existing character's
resources. The message in settings states the reason.

**Character loads but is invisible / cut off.** The pack's `layout.json` profile does not match the
window size. Try settings → size slider, and (developer mode) display zoom/offset.

**Settings changes seem ignored.** Close every instance and restart; multiple instances are allowed
on purpose (useful for comparisons) but each caches configuration at startup.

**Tray icon missing.** Windows hides tray icons in the overflow area; drag it onto the taskbar.

**Icons.** The app and tray use an original neutral paw, not game artwork. Reproduce all icon sizes with `npm run icons:neutral`.

### 10. Legal

- This is an **unofficial fan-made tool**. It is not affiliated with, endorsed by, or supported by
  the developer/publisher of XXL WOOFIA.
- **No game content is distributed here.** All characters, sprites, skeletons, atlases, audio and
  text belong to their respective rights holders.
- You are responsible for how you obtain character packs. Do not redistribute assets you have no
  right to redistribute.
- Third-party components and their licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Own code, documentation and original neutral icons use [MIT](LICENSE), Copyright (c) 2026 AustinHu. MIT does not cover Spine or other third-party content. Developers modifying or integrating the Spine runtime must satisfy its separate license terms; see the third-party notices.

---

## 中文

### 1. 这是什么

`XXL Desktop Pet`（中文名 **XXL 桌面宠物**）是一个独立的 Electron 桌面宠物**加载器**，本质是一个
Spine 运行时宿主。程序本身不带任何角色：首次启动会显示「还没有安装角色」的引导卡，角色通过导入
ZIP 资源包获得。角色包是纯数据（骨架、图集、贴图、布局、台词），加载器代码对所有角色通用。

<img width="1303" height="760" alt="bw" src="https://github.com/user-attachments/assets/bee87255-ffad-4fe7-965c-cd67e5f0665a" />


- 软件名：**XXL Desktop Pet**（中文：**XXL 桌面宠物**）
- 适配游戏：**XXL WOOFIA**（《XXL猛汉特区》）—— 非官方同人工具
- 与游戏开发商、发行商**不存在任何官方关联**

### 2. 主要功能

| | |
|---|---|
| Spine 渲染 | 兼容的Spine骨架（二进制 `.skel` 或 JSON）、皮肤、附件动画、预乘透明；导出与运行时版本须匹配 |
| 多角色 | 多角色目录同时存在，运行中切换，删目录即卸载 |
| 造型与状态 | 每角色独立造型表（SFW/成人）、表情、装甲/脱衣开关、静帧 CG 组 |
| 取景 | 每套造型独立布局档案，全局缩放与上下左右微调，窗口自动调整尺寸 |
| 设置面板 | 角色/造型/模式选择、大小、置顶、自动切换、硬件加速、鼠标穿透、退出 |
| 托盘 | 托盘图标打开设置，菜单可重新加载/退出，窗口点不到时有恢复菜单 |
| ZIP 导入 | 面板选择导入，或把 ZIP 丢进导入文件夹（自动识别，无需重启） |
| 空角色 | 没有任何角色也能正常启动，显示安装引导而不是白窗口 |
| AI 台词（可选） | 自带 DeepSeek Key 才启用，**默认关闭**，失败时回退角色包内的本地台词 |
| 鼠标穿透 | 透明区域点击直达桌面，全局快捷键切换完全穿透 |

### 3. Windows 系统要求

- Windows 10 / Windows 11，**x64**
- 用 EXE 时**不需要** Node.js、开发工具或命令行
- 磁盘约 400 MB（程序约 110 MB，每个角色包 30–60 MB）
- 显卡/驱动需支持 Chromium 透明窗口（默认关闭硬件加速，最保守）

### 4. 下载与安装

v1.0.0下载文件为 `XXL-Desktop-Pet-v1.0.0-win64.zip`。解压后双击 `XXL Desktop Pet.exe`。包内含便携程序、说明及许可证，不含角色包。本次不提供安装版下载，开发者可自行编译。

| 文件 | 用途 |
|---|---|
| `XXL Desktop Pet.exe` | **便携版**，双击即用，不安装任何东西 |
| `XXL Desktop Pet Setup <版本>.exe` | 可自行编译的安装版，不包含在本次下载中 |

注意事项：

- 发布包**未做代码签名**，首次运行 Windows SmartScreen 可能提示「未知发布者」：点 **更多信息 → 仍要运行**。
- 便携版每次启动会自解压到临时目录，属正常现象。
- 角色数据**不在** EXE 旁边，位置见 §7。

### 5. 桌宠使用

- **拖动**角色移动位置。
- **单击**角色触发动作（按角色规则）。
- **右键**窗口（或点托盘图标）打开设置。
- 设置里「退出桌宠」关闭程序；没有角色时，引导卡上也有独立的**退出**按钮。
- 全局快捷键（被占用时会自动换备用组合）：
  - `Ctrl+Shift+P` 切换完全鼠标穿透
  - `Ctrl+Shift+Q` 退出
  - 备用：`Ctrl+Alt+Shift+P` / `Ctrl+Alt+Shift+Q`，再往后是 `Ctrl+Alt+Shift+F1…F12` / `Ctrl+Alt+F1…F12`

### 6. 角色 ZIP 导入教程

**方式一：面板导入**

1. 右键窗口或点托盘图标打开设置。
2. 点「导入角色」。
3. 选一个 `.zip` 角色包。程序会校验、安装，然后刷新角色列表并立即加载新角色。

**方式二：导入文件夹**

1. 设置里点「打开导入文件夹」。
2. 把 `.zip` **原样**复制进去（**不要解压**）。
3. 程序会自动安装（另有 15 秒轮询兜底），装完角色出现在列表里。程序没开时先放进去也可以。

导入规则：会校验清单、SHA-256、CRC、路径穿越和大小上限，失败回滚。已存在的角色不会被覆盖，
编号重复会跳过并提示；损坏或资源冲突的包会拒绝安装。

### 7. 角色目录在哪里（自动识别）

加载器在启动时、以及每次导入完成后扫描一个**可写数据目录**：

```
%APPDATA%\XXL Desktop Pet\        <- 默认数据目录（EXE 版）
├─ characters\<编号>\             <- 每个已安装角色一个目录
├─ assets\models\...              <- ZIP 解包出来的素材
├─ 角色导入\                       <- 投递目录：把 ZIP 放这里
└─ renderer.*, assets\*.js|css     <- 运行外壳副本（不要改）
```

- **手动安装/卸载 = 增删目录**：删掉 `characters\` 下整个角色目录即卸载，重启生效。
- **只有便携版**支持把数据放 exe 旁边：在 exe 同级新建 `data` 文件夹即可（存在时才用）。
- 进阶：`--data-dir=<路径>` 或环境变量 `XXL_PET_DATA` 可整体覆盖。
- 设置面板会显示当前实际使用的数据目录，不用猜。

### 8. 源码编译

见 **[BUILD.md](BUILD.md)**，最短路径：

```bash
npm install
npm start          # 源码运行
npm run build      # 产出 dist/XXL Desktop Pet.exe（便携版）与安装包
```

### 9. 常见问题与故障排查

**启动后看不到窗口。** 可能还没装角色——空状态引导卡应在屏幕中间。连卡片都没有时，用
`--data-dir=<新的空目录>` 启动，排除角色目录损坏。

**双击没反应。** 看托盘：程序可能在运行但窗口在屏幕外，用托盘菜单「打开设置」。也可能是杀软拦了未签名 EXE。

**导入提示「角色已存在」。** 同编号角色已安装。卸载需手动删 `characters\<编号>`，程序不会替你删。

**导入被拒绝。** 包无效/损坏，或与已有角色资源冲突；设置面板会写明原因。

**角色加载了但看不见/被裁切。** 角色包的 `layout.json` 与窗口尺寸不匹配，调设置里的大小滑块，
开发者模式下还有显示缩放/位移。

**改了设置没反应。** 完整退出所有实例再启动。程序允许同时开多个（方便对比），但配置在启动时读取。

**托盘图标找不到。** Windows 会把它收进「显示隐藏的图标」区域，拖到任务栏即可。

**图标。** 程序与托盘使用原创中性爪印，不含游戏美术；`npm run icons:neutral` 可复现全部尺寸。

### 10. 声明与版权

- 本项目是**非官方同人工具**，与《XXL猛汉特区》（XXL WOOFIA）的开发商及发行商不存在官方关联。
- **本项目不提供任何游戏角色素材**。所有角色、贴图、骨骼、图集、音频与文本的版权归原权利人所有。
- 角色素材的获取方式由你自行负责；请勿再分发你无权再分发的内容。
- 第三方组件与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 自有代码、文档及原创中性图标采用 [MIT](LICENSE)，署名 `Copyright (c) 2026 AustinHu`。MIT不覆盖Spine等第三方内容；修改／集成Spine运行时的开发者须满足上游独立授权条件，详见第三方声明。
