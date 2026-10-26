# Character pack format (v1) · 角色资源包规范

> **English summary** — A character pack is a plain, unencrypted ZIP. Root contains
> `manifest.json`, one folder `characters/<id>/` with `character.json` / `assets.json` /
> `layout.json` (plus optional `dialogues.json`, `persona.json`), and `assets/models/…` (or
> `assets/stills/…`) with the actual skeleton/atlas/images. `manifest.json` lists every other file
> with `size` and `sha256`. The importer verifies the manifest, SHA-256, CRC32 and sizes, rejects
> path traversal / links / encrypted entries, installs atomically and rolls back on failure.
> Limits: ZIP ≤ 512 MiB, single file ≤ 128 MiB, uncompressed total ≤ 2 GiB, ≤ 4096 entries.
> This loader never ships packs; you must obtain them yourself.

本规范描述的是一种**纯数据**的角色包，不是独立程序。Electron/Spine 运行时、界面、硬件设置与
AI Key 都由桌宠保留，不放进角色包。

## ZIP 根目录

```text
manifest.json
characters/
  <角色编号>/            4～8 位数字，例如 12345
    character.json
    assets.json
    layout.json
    dialogues.json       可选；提供时必须是有效台词配置
    persona.json         可选；编号必须与目录一致
assets/
  models/
    <造型id>/
      xxx.skel 或 xxx.json
      xxx.atlas
      xxx.png
    ...本角色其它造型、伴生骨架、图集页、静帧...
```

不要在最外层再套一个角色名称文件夹；`manifest.json` 必须在根。

## manifest.json

```json
{
  "format": "spine-desktop-pet-character",
  "version": 1,
  "characterId": "12345",
  "name": "角色显示名",
  "createdAt": "2026-10-26T00:00:00.000Z",
  "files": [
    {
      "path": "characters/12345/character.json",
      "size": 123,
      "sha256": "<该文件实际内容的 64 位小写 SHA-256>"
    }
  ]
}
```

- `files` 必须完整列出**除 manifest 自身外**的所有普通文件，不能多也不能少。
- `size` 是未压缩字节数；`sha256` 必须与内容一致。
- `characterId` 与 `name` 必须与 `characters/<id>/character.json` 里的 `id` / `name` 一致。
- 上面只示意字段，不是可直接导入的完整包。

## 依赖与校验

- 必需：`character.json`、`assets.json`、`layout.json`，且至少一个非隐藏、可直接显示的造型。
- 每个 Spine 造型必须声明动画列表，并有对应的布局档案（`layout.json` 的 `profiles`）。
- 角色规则、彩蛋引用的造型都必须由本包自己的 `assets.json` 提供，不能引用包外资源。
- 资源相对路径以 `models/` 或 `stills/` 开头，安装时落在 `assets/` 下。
- 允许的文件类型：`skel`、`atlas`、`png/jpg/jpeg/webp`、`json`、`wav/mp3/ogg`。
  能装进来不代表有对应功能（例如本版本没有音效播放）。
- 只接受普通、未加密的 ZIP，支持 store / deflate。CRC32、SHA-256、文件大小逐一验证。
- 拒绝：绝对路径、路径穿越、反斜杠、Windows 保留文件名、大小写重复文件、符号链接、
  包内可执行脚本；安装目标里的目录链接同样拦截。
- 上限：ZIP ≤ 512 MiB，单文件 ≤ 128 MiB，解压总量 ≤ 2 GiB，清单最多 4096 个文件。

## 安装策略

1. 读取并校验清单 → 在临时 staging 目录解压并复算哈希/CRC。
2. 预检查目标资源冲突：**只新增不存在的资源**；同路径同内容可复用，内容不同则拒绝。
3. 原子提交完整角色目录，让角色加载器读得到。
4. 角色已存在则跳过（不会覆盖）；角色目录存在但未正常装载时，要求用户先人工移出备份。
5. 任何异常回滚本次新增资源并清理临时目录，不删除既有角色与素材。

面板选择 ZIP 与导入目录扫描走同一套安装逻辑，带进程内队列和跨实例锁，避免同时写同一目录。

## 关于打包工具

开发仓库里有一个把"已安装角色"导成 ZIP 的命令行工具，但它需要本地已有角色素材才能工作，
因此**不包含在本发布中**。自行制作角色包时，按上面的规范手写 `manifest.json` 即可
（每个文件的 `sha256` 用任意标准工具计算）。
