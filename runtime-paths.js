"use strict";
// 运行时目录解析：把「程序文件」和「角色数据」彻底分开。
//
// 开发版（源码运行）：两者都是项目目录，行为与以前完全一致。
// 打包版：程序文件在安装目录（可能只读），角色数据放在可写目录：
//   1) --data-dir=<路径> 或环境变量 XXL_PET_DATA（最高优先级，便于多开/测试/放U盘）
//   2) 便携版 exe 同级的 data 目录（用户手动建了才用，避免桌面多出一个文件夹）
//   3) %APPDATA%\XXL Desktop Pet（默认，任何安装位置都可写）
//
// 渲染层所有资源都是相对 renderer.html 的路径（assets/models/...），
// 所以数据目录里必须有一套「程序外壳」文件（html/js/css/播放器）。
// ensureShell() 负责在需要时把外壳同步过去，之后窗口从数据目录加载，
// 角色 ZIP 解压出来的 assets/models 才能在同一个相对根下被引用。
const fs = require("fs");
const path = require("path");

// 只有这些文件需要跟着数据目录走：真正由渲染进程直接按相对路径读取的文件。
// 主进程脚本（main.js / config-loader.js / character-importer.js / ai-*）仍从程序目录加载。
const SHELL_FILES = [
  "renderer.html",
  "renderer.js",
  "styles.css",
  "assets/dialogue-bubble.js",
  "assets/inject-companion.js",
  "assets/spine-layout.js",
  "assets/spine-player.min.js",
  "assets/spine-player.min.css",
  "assets/dialogue-meta.json"
];

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe-" + process.pid);
    fs.writeFileSync(probe, "1");
    fs.unlinkSync(probe);
    return true;
  } catch (error) {
    return false;
  }
}

function dataDirFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (const arg of list) {
    if (typeof arg === "string" && arg.startsWith("--data-dir=")) {
      const value = arg.slice("--data-dir=".length).trim();
      if (value) return value;
    }
  }
  return "";
}

// 返回 { dataRoot, source }。source 仅用于日志和设置面板展示"数据在哪"。
function resolveDataRoot(options = {}) {
  const appRoot = path.resolve(options.appRoot || __dirname);
  const override = dataDirFromArgv(options.argv) || String(options.env && options.env.XXL_PET_DATA || "").trim();
  if (override) {
    const dir = path.resolve(appRoot, override);
    if (!canWrite(dir)) throw new Error("指定的数据目录不可写：" + dir);
    return { dataRoot: dir, source: "override" };
  }
  if (!options.isPackaged) return { dataRoot: appRoot, source: "project" };
  const portableDir = String(options.portableDir || "").trim();
  if (portableDir) {
    const portableData = path.join(path.resolve(portableDir), "data");
    // 便携版：只有用户（或上一次运行）已经在 exe 旁建了 data 才用，避免污染桌面。
    if (fs.existsSync(portableData) && canWrite(portableData)) return { dataRoot: portableData, source: "portable" };
  }
  const userData = String(options.userDataDir || "").trim();
  if (userData && canWrite(userData)) return { dataRoot: path.resolve(userData), source: "user-data" };
  // 最后兜底：exe 同级 data（安装到用户可写目录时通常成立）
  const exeDir = String(options.exeDir || "").trim();
  if (exeDir) {
    const fallback = path.join(path.resolve(exeDir), "data");
    if (canWrite(fallback)) return { dataRoot: fallback, source: "exe-dir" };
  }
  return { dataRoot: appRoot, source: "app-dir" };
}

function ensureSubdirs(dataRoot) {
  for (const dir of ["characters", "角色导入", path.join("assets", "models"), path.join("assets", "stills")]) {
    try { fs.mkdirSync(path.join(dataRoot, dir), { recursive: true }); } catch (error) { /* 目录已存在或只读 */ }
  }
}

// 把渲染层外壳同步到数据目录。已经是最新（大小一致且不比源文件旧）就跳过。
// 返回真正应该 loadFile 的目录。
function ensureShell(appRoot, dataRoot, files = SHELL_FILES) {
  const source = path.resolve(appRoot);
  const target = path.resolve(dataRoot);
  if (source === target) return source;
  for (const relative of files) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    let fromStat;
    try { fromStat = fs.statSync(from); } catch (error) { continue; }
    let toStat = null;
    try { toStat = fs.statSync(to); } catch (error) { toStat = null; }
    if (toStat && toStat.size === fromStat.size && toStat.mtimeMs >= fromStat.mtimeMs) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch (error) {
      // 外壳同步失败时回退到程序目录加载：至少窗口还能起来
      console.warn("[pet] 同步外壳文件失败：" + relative + " " + (error && error.message ? error.message : error));
      return source;
    }
  }
  return target;
}

module.exports = { SHELL_FILES, resolveDataRoot, ensureShell, ensureSubdirs, canWrite, dataDirFromArgv };
