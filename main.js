const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, shell, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
// 角色配置按 characters/<id>/ 目录装载（详见 config-loader.js）
const { loadConfig } = require("./config-loader");

// 硬件加速必须在 app ready 之前决定，不能从渲染进程的 localStorage 临时切换。
// 设置单独保存在 Electron userData；读取失败时沿用旧版的安全默认值（关闭）。
// userData 路径同样要在 ready 之前拿到，但它也是顶层 Electron API —— 一并兜住。
// 拿不到就退回进程工作目录，绝不能让主进程在模块加载阶段直接抛错
//（那样窗口根本不会创建，表现就是"双击毫无反应"，连日志都看不到）。
// 打包版的用户数据目录固定成 "XXL Desktop Pet"，不要跟着内部包名（xxlwoofia-10423-desktop-pet）走，
// 否则 %APPDATA% 里会出现一个用户看不懂的目录名。
// 开发版不改：保持原来的目录，免得现有设置/存档丢失。
const userDataDir = (() => {
  try {
    if (app.isPackaged) {
      try { app.setName("XXL Desktop Pet"); } catch (error) { /* 旧版本忽略 */ }
      try {
        const target = path.join(app.getPath("appData"), "XXL Desktop Pet");
        app.setPath("userData", target);
      } catch (error) { /* 设置失败时沿用默认 */ }
    }
    return app.getPath("userData");
  } catch (error) {
    console.warn("读取 userData 目录失败：", error && error.message ? error.message : error);
    return process.cwd();
  }
})();
const performanceSettingsPath = path.join(userDataDir, "performance-settings.json");
// ===== 程序目录 / 数据目录分离 =====
// APP_ROOT：程序文件（打包后在安装目录，可能只读）。
// dataRoot：角色、导入目录、AI 配置等人可写数据（打包后默认 %APPDATA%\XXL Desktop Pet）。
// 开发版两者相同，源码运行的既有行为不变。
const APP_ROOT = __dirname;
const { resolveDataRoot, ensureShell, ensureSubdirs } = require("./runtime-paths");
const runtime = (() => {
  const fallback = { dataRoot: APP_ROOT, shellRoot: APP_ROOT, source: "app-dir" };
  try {
    const resolved = resolveDataRoot({
      appRoot: APP_ROOT,
      isPackaged: app.isPackaged,
      userDataDir,
      exeDir: path.dirname(process.execPath),
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR || "",
      argv: process.argv,
      env: process.env
    });
    try { ensureSubdirs(resolved.dataRoot); } catch (error) { /* 数据目录只读时不阻塞启动 */ }
    const shellRoot = ensureShell(APP_ROOT, resolved.dataRoot);
    return { dataRoot: resolved.dataRoot, shellRoot, source: resolved.source };
  } catch (error) {
    console.warn("解析数据目录失败，回退到程序目录：", error && error.message ? error.message : error);
    return fallback;
  }
})();
// 图标出处统一在 APP_ROOT（不随数据目录走），方便以后替换图标只改一处
const ICON_DIR = path.join(APP_ROOT, "assets");
console.log("[pet] 程序目录:", APP_ROOT, "| 数据目录:", runtime.dataRoot, "(" + runtime.source + ")");
// AI 台词服务：Key 与网络都留在主进程，渲染层只通过 IPC 拿"一句台词"。
// 未配置 Key / 欠费 / 超时 / 冷却时返回 ok:false，渲染层自动回退本地 dialogues.json。
const { createAiDialogue } = require("./ai-dialogue");
// 开发/测试约定（2026-10-26 用户要求）：带 --no-ai 启动时强制关闭 AI 对话。
// 我（助手）在测试、截图、自动化时一律用这个参数启动；只有用户明确要求才不带。
const aiDisabledByFlag = process.argv.includes("--no-ai");
const aiDialogue = createAiDialogue({
  root: runtime.dataRoot,
  // 面板上的开关属于"这台机器"的偏好，写 userData（安装目录可能只读）
  userSettingsPath: path.join(userDataDir, "ai-settings.json"),
  forceDisabled: aiDisabledByFlag
});
const { createCharacterImporter } = require("./character-importer");
const characterImporter = createCharacterImporter({
  root: runtime.dataRoot,
  onResult(result) {
    if (result.ok) {
      aiDialogue.reload();
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("characters-imported", result);
    }
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("character-import-result", result);
  },
  onError(error) {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("character-import-result", {
      ok: false, code: "INBOX_ERROR", message: "导入目录暂不可读：" + error.message
    });
  }
});
function readPerformanceSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(performanceSettingsPath, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return {};
  }
}
function writePerformanceSettings(next) {
  fs.mkdirSync(path.dirname(performanceSettingsPath), { recursive: true });
  fs.writeFileSync(performanceSettingsPath, JSON.stringify(next, null, 2), "utf8");
}
const startupPerformanceSettings = readPerformanceSettings();
const hardwareAccelerationSaved = startupPerformanceSettings.hardwareAcceleration === true;
const hardwareAccelerationForcedOff = process.argv.includes("--disable-gpu");
const hardwareAccelerationEnabled = hardwareAccelerationSaved && !hardwareAccelerationForcedOff;

// 本机 Electron 44 的 Chromium 沙箱会让 GPU 子进程 0xC0000005 崩溃，
// 进而弹出 "Error launching CrashSender.exe"，窗口根本起不来（表现就是双击毫无反应）。
// 打包成 exe 后双击启动是没有命令行参数的，所以必须在这里用代码补上 --no-sandbox；
// 硬件加速默认仍关闭；用户可以在普通设置菜单开启，并在下次启动生效。
// 用 try + 判空包住：某些宿主环境里 app 可能是字符串/undefined，不能让它把主进程搞崩。
try {
  if (app && app.commandLine && typeof app.commandLine.appendSwitch === "function") {
    app.commandLine.appendSwitch("no-sandbox");
  }
} catch (e) {
  console.warn("appendSwitch(no-sandbox) 失败：", e && e.message ? e.message : e);
}

if (!hardwareAccelerationEnabled) {
  try {
    if (app && typeof app.disableHardwareAcceleration === "function") {
      app.disableHardwareAcceleration();
    }
  } catch (error) {
    console.warn("disableHardwareAcceleration 失败：", error && error.message ? error.message : error);
  }
}

let petWindow = null;
let petTray = null;
let trayRecoveryMenu = null;
let settingsRequestTimer = null;
let settingsRequestId = 0;
let dragTimer = null;
let dragOrigin = null;
let dragStartedAt = 0;
let dragLastPosition = null;
let clickThrough = false;
const controlShortcuts = { toggle: null, quit: null };

function registerAvailableShortcut(candidates, callback) {
  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, callback)) return accelerator;
    } catch (error) {
      // A rejected or occupied accelerator must not prevent other candidates.
    }
  }
  return null;
}
// 鼠标是否停在角色的不透明像素上（由渲染进程上报）。
// 窗口是透明矩形、角色只占其中约 30%，所以透明区域默认让点击穿透到桌面。
let pixelHit = false;

// 三态合成：完全穿透(clickThrough) 优先，其次看是否命中角色像素
function applyMouseState() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const ignore = clickThrough || !pixelHit;
  // forward:true —— 即使处于忽略状态，也把鼠标移动事件转发给页面，
  // 渲染进程才能持续做像素命中判断，从而在"移到角色身上"时恢复可点击。
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
}

function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOrigin = null;
  dragStartedAt = 0;
  dragLastPosition = null;
}

function setClickThrough(enabled) {
  // Never strand a fully transparent instance without a working recovery key.
  clickThrough = Boolean(enabled) && Boolean(controlShortcuts.toggle);
  applyMouseState();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("click-through-changed", clickThrough);
  }
}

function cancelSettingsRequest() {
  if (settingsRequestTimer !== null) clearTimeout(settingsRequestTimer);
  settingsRequestTimer = null;
  settingsRequestId++;
}

function showTrayRecoveryMenu() {
  if (petTray && !petTray.isDestroyed()) petTray.popUpContextMenu(trayRecoveryMenu);
}

function openSettingsFromTray() {
  stopDrag();
  cancelSettingsRequest();
  if (!petWindow || petWindow.isDestroyed()) {
    showTrayRecoveryMenu();
    return;
  }
  const target = petWindow;
  // Recovery must work even when full passthrough is enabled or no character
  // pixels exist yet. The renderer restores normal hit testing after opening.
  clickThrough = false;
  pixelHit = true;
  applyMouseState();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  const requestId = settingsRequestId;
  settingsRequestTimer = setTimeout(() => {
    if (requestId !== settingsRequestId) return;
    settingsRequestTimer = null;
    showTrayRecoveryMenu();
  }, 1200);
  try {
    target.webContents.send("click-through-changed", false);
    target.webContents.send("open-settings", requestId);
  } catch (error) {
    cancelSettingsRequest();
    showTrayRecoveryMenu();
  }
}

function createTray() {
  // The icon lives in assets so it is included by the existing packaging rule.
  const iconPath = path.join(ICON_DIR, "tray.ico");
  const icon = nativeImage.createFromPath(iconPath);
  // 图标文件缺失时不能让托盘直接抛错（否则整个程序看起来"双击没反应"）
  petTray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  petTray.setToolTip("XXL Desktop Pet · 右键设置（" + process.pid + "）");
  trayRecoveryMenu = Menu.buildFromTemplate([
    { label: "打开设置", click: openSettingsFromTray },
    { label: "重新加载桌宠", click: () => {
      stopDrag();
      cancelSettingsRequest();
      if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.reload();
      else createWindow();
    } },
    { type: "separator" },
    { label: "打开角色数据目录", click: () => { shell.openPath(runtime.dataRoot).catch(() => {}); } },
    // This action lives entirely in main: no renderer/Spine/IPC response needed.
    { label: "退出此桌宠", click: () => app.quit() }
  ]);
  petTray.on("right-click", openSettingsFromTray);
  petTray.on("click", openSettingsFromTray);
}

function createWindow() {
  const windowIcon = path.join(ICON_DIR, "icon.ico");
  petWindow = new BrowserWindow({
    width: 560,
    height: 760,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    // 窗口图标（Alt+Tab / 任务管理器 / 设置窗口）
    ...(fs.existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  petWindow.setAlwaysOnTop(true, "floating");
  petWindow.setMenuBarVisibility(false);
  // 初始进入"未命中"状态：透明区域直接穿透，只有鼠标移到角色实体上才恢复捕获。
  applyMouseState();
  // 从数据目录加载：打包版角色资源在可写目录，必须和 renderer.html 同一个相对根
  petWindow.loadFile(path.join(runtime.shellRoot, "renderer.html"));
  // 调试用：--pos=x,y 指定初始位置，方便同时开两个桌宠做对比
  const posArg = process.argv.find(arg => arg.startsWith("--pos="));
  if (posArg) {
    const [x, y] = posArg.slice(6).split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) petWindow.setPosition(x, y);
  }
  petWindow.on("closed", () => {
    stopDrag();
    cancelSettingsRequest();
    petWindow = null;
  });
  // If pointer capture is interrupted by task switching or a renderer failure,
  // never leave the native move timer running indefinitely.
  petWindow.on("blur", stopDrag);
  petWindow.webContents.on("render-process-gone", stopDrag);
}

app.whenReady().then(() => {
  // Windows 任务栏/通知归属：没有它任务栏会显示 electron 默认图标
  try {
    app.setAppUserModelId("com.xxl.desktoppet");
    app.setName("XXL Desktop Pet");
  } catch (error) { /* 非 Windows 或旧版本忽略 */ }
  // file:// 脚本（renderer.js / inject-companion.js）会被 Chromium 磁盘缓存，
  // 改代码后窗口可能还在跑旧脚本（表现为换装/层级修复"不生效"）。启动时清一次。
  session.defaultSession.clearCache().catch(() => {});
  controlShortcuts.toggle = registerAvailableShortcut([
    "CommandOrControl+Shift+P", "CommandOrControl+Alt+Shift+P",
    ...Array.from({ length: 12 }, (_, i) => "CommandOrControl+Alt+Shift+F" + (i + 1))
  ], () => setClickThrough(!clickThrough));
  controlShortcuts.quit = registerAvailableShortcut([
    "CommandOrControl+Shift+Q", "CommandOrControl+Alt+Shift+Q",
    ...Array.from({ length: 12 }, (_, i) => "CommandOrControl+Alt+F" + (i + 1))
  ], () => app.quit());
  createTray();
  createWindow();
  characterImporter.start().catch(error => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send("character-import-result", {
      ok: false, code: "INBOX_ERROR", message: "无法打开角色导入目录：" + error.message
    });
  });
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  characterImporter.stop();
  cancelSettingsRequest();
  stopDrag();
  globalShortcut.unregisterAll();
  if (petTray && !petTray.isDestroyed()) petTray.destroy();
  petTray = null;
});

ipcMain.on("settings-opened", (event, requestId) => {
  if (!petWindow || petWindow.isDestroyed() || event.sender !== petWindow.webContents
    || requestId !== settingsRequestId) return;
  cancelSettingsRequest();
});

ipcMain.on("drag-start", () => {
  if (!petWindow || petWindow.isDestroyed() || clickThrough) return;
  stopDrag();
  const cursor = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  dragOrigin = { cursor, bounds };
  dragStartedAt = Date.now();
  dragLastPosition = { x: bounds.x, y: bounds.y };
  dragTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !dragOrigin) return stopDrag();
    if (Date.now() - dragStartedAt > 15000) return stopDrag();
    const now = screen.getCursorScreenPoint();
    const x = dragOrigin.bounds.x + now.x - dragOrigin.cursor.x;
    const y = dragOrigin.bounds.y + now.y - dragOrigin.cursor.y;
    if (dragLastPosition && dragLastPosition.x === x && dragLastPosition.y === y) return;
    dragLastPosition = { x, y };
    petWindow.setPosition(x, y, false);
  }, 16);
});

ipcMain.on("drag-stop", stopDrag);
ipcMain.on("set-click-through", (_event, enabled) => setClickThrough(enabled));
ipcMain.on("set-mouse-hit", (_event, enabled) => {
  pixelHit = Boolean(enabled);
  applyMouseState();
});
ipcMain.on("set-always-on-top", (_event, enabled) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.setAlwaysOnTop(Boolean(enabled), "floating");
});
// 渲染层不直接读文件：角色是"按目录装载"的，由主进程扫描数据目录后合并返回
ipcMain.handle("load-config", () => loadConfig({
  root: runtime.dataRoot,
  // 公共台词元数据属于程序文件，不随角色数据目录走
  metaFile: path.join(APP_ROOT, "assets", "dialogue-meta.json")
}));
function isPetSender(event) { return !!(petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents); }
ipcMain.handle("character-import-status", event => isPetSender(event) ? characterImporter.status() : null);
ipcMain.handle("character-import-choose", async event => {
  if (!isPetSender(event)) return { ok: false, code: "INVALID_SENDER", message: "无法识别设置窗口" };
  try {
    const selected = await dialog.showOpenDialog(petWindow, { title: "导入角色ZIP", properties: ["openFile"],
      filters: [{ name: "角色ZIP资源包", extensions: ["zip"] }] });
    if (selected.canceled || !selected.filePaths.length) return { ok: false, canceled: true, message: "已取消导入" };
    return await characterImporter.importFile(selected.filePaths[0], "manual");
  } catch (error) { return { ok: false, code: "IMPORT_ERROR", message: "无法导入角色：" + error.message }; }
});
ipcMain.handle("character-import-open-directory", async event => {
  if (!isPetSender(event)) return { ok: false };
  const error = await shell.openPath(characterImporter.inboxDir);
  return { ok: !error, message: error || "已打开导入文件夹" };
});
// 设置面板要能告诉用户"角色装在哪、怎么手动放"，打包后尤其重要（程序目录只读）
ipcMain.handle("get-runtime-info", event => isPetSender(event) ? {
  dataRoot: runtime.dataRoot,
  appRoot: APP_ROOT,
  shellRoot: runtime.shellRoot,
  source: runtime.source,
  version: app.getVersion(),
  packaged: app.isPackaged
} : null);
ipcMain.handle("open-data-directory", async event => {
  if (!isPetSender(event)) return { ok: false };
  fs.mkdirSync(runtime.dataRoot, { recursive: true });
  const error = await shell.openPath(runtime.dataRoot);
  return { ok: !error, message: error || "已打开角色数据目录" };
});

// ===== AI 台词（DeepSeek）=====
// 单次只返回一句；任何异常都转成 ok:false，绝不能因为接口问题让桌宠不说话。
ipcMain.handle("ai-dialogue", async (_event, payload) => {
  const request = payload && typeof payload === "object" ? payload : {};
  try {
    return await aiDialogue.request(request);
  } catch (error) {
    console.warn("[pet] AI 请求异常：", error && error.message ? error.message : error);
    return { ok: false, text: "", source: "local", reason: "error", message: "AI 请求异常，使用本地台词" };
  }
});
ipcMain.handle("ai-status", () => aiDialogue.status());
ipcMain.handle("ai-set-enabled", (_event, enabled) => aiDialogue.setEnabled(Boolean(enabled)));
// 面板里直接填 Key/模型：写 ai-config.local.json，返回最新状态
ipcMain.handle("ai-save-config", (_event, patch) =>
  aiDialogue.saveConfig(patch && typeof patch === "object" ? patch : {}));
ipcMain.handle("ai-test", async (_event, payload) => {
  try {
    return await aiDialogue.testConnection(payload && payload.roleId);
  } catch (error) {
    return { ok: false, reason: "error", message: "测试失败：" + (error && error.message ? error.message : error) };
  }
});
ipcMain.on("ai-open-config", () => {
  // 打开配置文件，用户填完 Key 保存即可，下一次请求自动重新加载
  shell.openPath(aiDialogue.configPath).catch(() => {});
});

ipcMain.handle("get-performance-settings", () => ({
  hardwareAcceleration: readPerformanceSettings().hardwareAcceleration === true,
  activeHardwareAcceleration: hardwareAccelerationEnabled,
  hardwareAccelerationForcedOff,
  // 面板里要告诉用户"万一开不起来该删哪个文件"，所以把真实路径一起交给渲染进程
  settingsPath: performanceSettingsPath
}));
ipcMain.handle("get-control-shortcuts", () => ({ ...controlShortcuts }));
ipcMain.handle("set-hardware-acceleration", (_event, enabled) => {
  const hardwareAcceleration = Boolean(enabled);
  const next = Object.assign({}, readPerformanceSettings(), { hardwareAcceleration });
  try {
    writePerformanceSettings(next);
    return {
      ok: true,
      hardwareAcceleration,
      activeHardwareAcceleration: hardwareAccelerationEnabled,
      hardwareAccelerationForcedOff,
      restartRequired: hardwareAcceleration !== hardwareAccelerationEnabled
    };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});
ipcMain.on("resize-window", (_event, width, height) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  // 下限要能容纳角色大小滑块的最小值 50%（560x760 * 0.5 = 280x380）；
  // 上限要容纳角色尾巴、装甲和动作范围所需的自动透明扩宽。
  const display = screen.getDisplayNearestPoint({ x: petWindow.getBounds().x, y: petWindow.getBounds().y });
  const maxWidth = Math.max(1920, display.workArea.width * 2);
  const safeWidth = Math.max(240, Math.min(maxWidth, Math.round(Number(width) || 560)));
  const safeHeight = Math.max(300, Math.min(1200, Math.round(Number(height) || 760)));
  const bounds = petWindow.getBounds();
  // 尺寸没变就不要重复 setSize —— 每次 resize 都会重建透明窗口的合成层
  if (bounds.width === safeWidth && bounds.height === safeHeight) return;
  // 保持窗口中心水平不变，避免自动扩宽时角色横向跳动
  const oldCenterX = bounds.x + bounds.width / 2;
  const newX = Math.round(oldCenterX - safeWidth / 2);
  petWindow.setSize(safeWidth, safeHeight, false);
  petWindow.setPosition(newX, bounds.y, false);
});
ipcMain.on("move-window", (_event, x, y) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const bounds = petWindow.getBounds();
  // 兜底：不管渲染进程算出什么，都不许把窗口整个推到看不见的地方
  const point = { x: Math.round(x), y: Math.round(y) };
  const work = screen.getDisplayNearestPoint(point).workArea;
  const minVisible = 80;
  const safeX = Math.min(Math.max(point.x, work.x - bounds.width + minVisible), work.x + work.width - minVisible);
  const safeY = Math.min(Math.max(point.y, work.y - bounds.height + minVisible), work.y + work.height - minVisible);
  if (safeX === bounds.x && safeY === bounds.y) return;
  petWindow.setPosition(safeX, safeY, true);
});
ipcMain.on("close-pet", () => app.quit());
ipcMain.on("open-external", (_event, url) => {
  if (typeof url === "string" && url.startsWith("https://")) {
    shell.openExternal(url);
  }
});
