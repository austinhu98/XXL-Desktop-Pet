const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  startDrag: () => ipcRenderer.send("drag-start"),
  stopDrag: () => ipcRenderer.send("drag-stop"),
  setClickThrough: enabled => ipcRenderer.send("set-click-through", Boolean(enabled)),
  setAlwaysOnTop: enabled => ipcRenderer.send("set-always-on-top", Boolean(enabled)),
  // 已装载的角色配置（characters/<id>/ 合并结果）
  loadConfig: () => ipcRenderer.invoke("load-config"),
  importCharacterZip: () => ipcRenderer.invoke("character-import-choose"),
  getCharacterImportStatus: () => ipcRenderer.invoke("character-import-status"),
  openCharacterImportDirectory: () => ipcRenderer.invoke("character-import-open-directory"),
  // 数据目录信息：角色装在哪、程序在哪（打包版要在设置面板里显示给用户）
  getRuntimeInfo: () => ipcRenderer.invoke("get-runtime-info"),
  openDataDirectory: () => ipcRenderer.invoke("open-data-directory"),
  onCharactersImported: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("characters-imported", listener);
    return () => ipcRenderer.removeListener("characters-imported", listener);
  },
  onCharacterImportResult: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("character-import-result", listener);
    return () => ipcRenderer.removeListener("character-import-result", listener);
  },
  // AI 台词：只拿一句文本，Key 与网络都在主进程
  aiLine: payload => ipcRenderer.invoke("ai-dialogue", payload && typeof payload === "object" ? payload : {}),
  getAiStatus: () => ipcRenderer.invoke("ai-status"),
  setAiEnabled: enabled => ipcRenderer.invoke("ai-set-enabled", Boolean(enabled)),
  saveAiConfig: patch => ipcRenderer.invoke("ai-save-config", patch && typeof patch === "object" ? patch : {}),
  aiTest: payload => ipcRenderer.invoke("ai-test", payload && typeof payload === "object" ? payload : {}),
  openAiConfig: () => ipcRenderer.send("ai-open-config"),
  getPerformanceSettings: () => ipcRenderer.invoke("get-performance-settings"),
  getControlShortcuts: () => ipcRenderer.invoke("get-control-shortcuts"),
  setHardwareAcceleration: enabled => ipcRenderer.invoke("set-hardware-acceleration", Boolean(enabled)),
  resizeWindow: (width, height) => ipcRenderer.send("resize-window", width, height),
  // 窗口被拖到屏幕角落、面板放不下时，临时把它挪进屏幕（关闭面板会挪回去）
  moveWindow: (x, y) => ipcRenderer.send("move-window", Math.round(x), Math.round(y)),
  // 像素级命中：鼠标是否停在角色不透明像素上（由 renderer 每次移动时上报）
  setMouseHit: onBody => ipcRenderer.send("set-mouse-hit", Boolean(onBody)),
  close: () => ipcRenderer.send("close-pet"),
  openExternal: url => ipcRenderer.send("open-external", url),
  onClickThroughChanged: callback => ipcRenderer.on("click-through-changed", (_event, value) => callback(value)),
  onOpenSettings: callback => {
    const listener = (_event, requestId) => callback(requestId);
    ipcRenderer.on("open-settings", listener);
    return () => ipcRenderer.removeListener("open-settings", listener);
  },
  settingsOpened: requestId => ipcRenderer.send("settings-opened", requestId)
});
