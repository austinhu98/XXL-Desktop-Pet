# Third-party components · 第三方组件与许可证

`XXL Desktop Pet` 自身代码之外，发布内容包含/依赖以下第三方组件。它们的许可证**不等同于**本项目
自有代码许可证。自有代码、文档和原创几何爪印图标采用MIT，Copyright (c) 2026 AustinHu；详见 [LICENSE](LICENSE)。MIT不重新授权第三方组件或游戏内容。公开发布请保留本文件。

| Component | Version | License | Copyright / notes |
|---|---|---|---|
| Spine Web Player (`assets/spine-player.min.js`, `assets/spine-player.min.css`) | bundled build of `@esotericsoftware/spine-player` (runtime 4.x) | **Spine Runtimes License Agreement** (not MIT) | © Esoteric Software LLC — https://esotericsoftware.com/spine-runtimes-license |
| Electron | 44.9.1 | MIT (Chromium and other components carry their own licenses, shipped as `LICENSES.chromium.html` inside the app) | © Electron contributors, © The Chromium Authors |
| Node.js runtime bundled in Electron | — | MIT and third-party licenses | © Node.js contributors |
| electron-builder | 24.13.3 | MIT | © 2015–2024 Loïc Mahana and contributors. Build-time only, not shipped. |
| yauzl | 3.2.0 | MIT | © Josh Wolfe |
| buffer-crc32 | 0.2.13 | MIT | © Brian J. Cardiff |
| pend | 1.2.0 | MIT | © Andrew Kelley |

## About the Spine runtime (important)

The Spine Runtimes are **not** MIT and are not covered by any license this project can grant.
The maintainer confirms a valid Spine Editor license was held when the runtime was integrated. The full upstream license and copyright notice are provided in [licenses/spine-runtimes-license.txt](licenses/spine-runtimes-license.txt). This does not sublicense the Spine Editor. Developers modifying or integrating software containing the Spine Runtimes must comply with the upstream terms, including section 2 of https://esotericsoftware.com/spine-editor-license . Non-commercial or educational intent alone does not replace those requirements.

维护者确认集成时已持有有效Spine Editor授权；不分发编辑器、密钥或购买凭证。修改或集成运行时的软件开发者须遵守上游条件。“非商业／学习用途”不替代授权。普通用户使用与开发者修改的条件不应混为一谈。

The bundled player bytes are preserved, with the full license supplied separately. The exact upstream build identifier is not recorded; no claim of compatibility with every Spine 4.x export is made.

Full MIT notices for distributed dependencies are included in `licenses/electron-LICENSE.txt`, `licenses/yauzl-LICENSE.txt`, `licenses/buffer-crc32-LICENSE.txt` and `licenses/pend-LICENSE.txt`. Electron's other runtime notices are included in `LICENSES.chromium.html` inside the portable runtime.

## Game assets

No game assets are distributed with this project. Character sprites, skeletons, atlases, audio and
text belong to their respective rights holders. The `characters/` folder in this repository is empty
on purpose, and no character ZIP pack is included.

The public application, EXE and tray use an original geometric paw icon, not game artwork. 本公开版程序、EXE和托盘图标均为原创中性几何爪印，不含游戏Logo。
