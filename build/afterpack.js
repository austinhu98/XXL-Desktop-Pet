// electron-builder 的 afterPack 钩子：给打包产物写入图标与版本信息。
//
// 为什么不直接用 electron-builder 内置的 rcedit：
// 它需要解压 winCodeSign 包，而该包内含 macOS 符号链接，普通用户权限解不开
// （报 "Cannot create symbolic link : 客户端没有所需的特权"）。
// 所以关掉内置的 signAndEditExecutable，改在这里调用缓存里已经存在的 rcedit.exe。
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const productName = context.packager.appInfo.productFilename;
  const exe = path.join(appOutDir, `${productName}.exe`);
  const projectDir = context.packager.projectDir;
  const icon = path.join(projectDir, "build", "icon.ico");

  if (!fs.existsSync(exe)) {
    console.log("  [afterPack] 跳过：找不到 " + exe);
    return;
  }
  if (!fs.existsSync(icon)) {
    console.log("  [afterPack] 跳过：找不到图标 " + icon);
    return;
  }

  // 在 electron-builder 的缓存里找 rcedit（解压 winCodeSign 时已经落在磁盘上）
  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  let rcedit = null;
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, dir, "rcedit-x64.exe");
      if (fs.existsSync(p)) { rcedit = p; break; }
    }
  }
  if (!rcedit) {
    console.log("  [afterPack] 警告：没找到 rcedit-x64.exe，exe 将保留默认 Electron 图标");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
  const ver = (pkg.version || "1.0.0") + ".0";

  try {
    execFileSync(rcedit, [
      exe,
      "--set-icon", icon,
      "--set-file-version", ver,
      "--set-product-version", ver,
      "--set-version-string", "ProductName", productName,
      "--set-version-string", "FileDescription", "XXL Desktop Pet 桌面宠物",
      "--set-version-string", "OriginalFilename", `${productName}.exe`
    ], { stdio: "inherit" });
    console.log("  [afterPack] 已写入图标与版本信息: " + exe);
  } catch (e) {
    console.log("  [afterPack] rcedit 失败（不影响能运行）: " + e.message);
  }
};
