const stage = document.getElementById("stage");
const panel = document.getElementById("panel");
const dialogueBubble = window.PetDialogue
  ? new window.PetDialogue.DialogueBubble(document.getElementById("dialogueBubble"), {
    getHeadBounds: () => window.PetDialogue.projectHeadBounds(player, spine)
  }) : null;
// 闲置台词：无操作 5 分钟说一句，之后每 5 分钟一句
const IDLE_DIALOGUE_INTERVAL_MS = 300000;
// setTimeout 单次 5 分钟在后台/被节流时会延后很多，甚至看起来"永远不来"。
// 除了调度器自己的定时器，再挂一个 15 秒的看门狗按绝对时间兜底（留 5 秒宽限，避免和调度器抢着播）。
const IDLE_DIALOGUE_GRACE_MS = 5000;
const IDLE_DIALOGUE_WATCHDOG_MS = 15000;
let idleWatchdog = null;
let lastIdleSpeakAt = 0;
const idleDialogue = dialogueBubble && window.PetDialogue.IdleDialogueScheduler
  ? new window.PetDialogue.IdleDialogueScheduler({
    intervalMs: IDLE_DIALOGUE_INTERVAL_MS,
    canSpeak: canSpeakIdleDialogue,
    onSpeak: speakIdleDialogue
  }) : null;
const characterSelect = document.getElementById("character");
const emptyState = document.getElementById("emptyState");
const modeSelect = document.getElementById("mode");
const modeLabel = document.getElementById("modeLabel");
const devRow = document.getElementById("devRow");
const devHint = document.getElementById("devHint");
const modelSelect = document.getElementById("model");
const faceSelect = document.getElementById("face");
const face2Select = document.getElementById("face2");
const faceRow = document.getElementById("faceRow");
const face2Row = document.getElementById("face2Row");
const r18Select = document.getElementById("r18");
const r18Row = document.getElementById("r18Row");
const animationSelect = document.getElementById("animation");
const sizeSlider = document.getElementById("size");
const sizeValue = document.getElementById("sizeValue");
const devModeCheckbox = document.getElementById("devMode");
const alwaysOnTopCheckbox = document.getElementById("alwaysOnTop");
const autoSwitchCheckbox = document.getElementById("autoSwitch");
const hardwareAccelerationCheckbox = document.getElementById("hardwareAcceleration");
const hardwareAccelerationStatus = document.getElementById("hardwareAccelerationStatus");
const hardwareAccelerationHint = document.getElementById("hardwareAccelerationHint");
const dispCtrl = document.getElementById("dispCtrl");
const dispZoomSlider = document.getElementById("dispZoom");
const dispZoomValue = document.getElementById("dispZoomValue");
const dispXSlider = document.getElementById("dispX");
const dispXValue = document.getElementById("dispXValue");
const dispYSlider = document.getElementById("dispY");
const dispYValue = document.getElementById("dispYValue");
const dispResetButton = document.getElementById("dispReset");
const armorBox = document.getElementById("armorBox");
const armorGrid = document.getElementById("armorGrid");
const armorCount = document.getElementById("armorCount");
const armorAllOnButton = document.getElementById("armorAllOn");
const armorAllOffButton = document.getElementById("armorAllOff");
const rfyVariantBox = document.getElementById("rfyVariantBox");
const rfyVariantGrid = document.getElementById("rfyVariantGrid");
const sideHeadRow = document.getElementById("sideHeadRow");
const sideHeadGroup = document.getElementById("sideHeadGroup");
const aiEnabledCheckbox = document.getElementById("aiEnabled");
const aiStatusText = document.getElementById("aiStatus");
const aiOpenConfigButton = document.getElementById("aiConfig");
const aiHint = document.getElementById("aiHint");
const aiKeyInput = document.getElementById("aiKey");
const aiModelInput = document.getElementById("aiModel");
const aiSaveButton = document.getElementById("aiSave");
const aiTestButton = document.getElementById("aiTest");
const aiClearButton = document.getElementById("aiClear");
const aiKeyState = document.getElementById("aiKeyState");
const aiBox = document.getElementById("aiBox");

let assets = [];
let characters = [];   // characters/<角色ID>/character.json：角色 → 该角色可选的造型
// 没有任何角色时显示引导卡片；此状态下整窗必须可点（否则透明区穿透，卡片点不到）
let emptyStateVisible = false;
let currentAsset = null;
let player = null;
// Every model/stills switch invalidates callbacks from older SpinePlayer loads.
// This prevents a slow previous asset from overwriting the current player.
let assetLoadGeneration = 0;
let layoutProfiles = {};
let layoutController = null;
let sceneStepIndex = 0;
// 进入 CG 后是否处于"自动按序播一遍"的状态（autoAdvance 的造型才用）
let sceneAutoPlaying = false;
let sceneHoldTimer = null;   // 某一段的额外停留时间（holdMs）
let scenePlaybackGeneration = 0;
// ===== 静帧轮播（kind: "stills"）=====
// 这类"造型"不是 Spine 骨骼，而是一组静态大图（白威CG静态图 = 9 张 2048x1152 差分图）。
// 它和 Spine 播放器互斥：loadStills 会先把 player 销毁，切回骨骼造型时再收起这一层。
let stillsIndex = 0;      // 当前显示的帧序号
let stillsTimer = null;   // 自动轮播定时器
let stillsPreload = [];   // 预加载的 Image，避免切到下一张时闪一下空白
let dragging = false;
let downPoint = null;
let downRegion = null;
let downDialogueArea = null;
let clickThrough = false;
let __lastHit = null;
const __c = { reaction: 0, anim: 0, pointerup: 0, bgMasked: 0 };

// ===== 渲染限帧 =====
// SpinePlayer 默认跟随显示器刷新率持续 drawFrame（高刷屏可能超过 60 FPS）。
// 正常观看、交互和 CG 保持流畅的 60 FPS；普通待机 8 秒后降到 30 FPS。
// 这里只减少绘制次数，动画时间仍按真实时间推进，不会改变动作速度。
const ACTIVE_RENDER_FPS = 60;
const IDLE_RENDER_FPS = 30;
const RENDER_IDLE_AFTER_MS = 8000;
let lastRenderActivityAt = Date.now();
let frameLimiterTimer = null;
let frameLimiterPlayer = null;
let frameLimiterFps = ACTIVE_RENDER_FPS;

function markRenderActivity() {
  lastRenderActivityAt = Date.now();
  if (idleDialogue) idleDialogue.reset();
}

// ===== AI 台词（DeepSeek）=====
// 主进程负责网络与 Key，渲染层只在"要说话"时取一句。
// 取不到（未配置 Key / 欠费 / 超时 / 冷却 / 关了开关）就回退 dialogues.json 的原台词，
// 本地台词的选池规则一个字都没改。
const AI_STREAK_WINDOW_MS = 8000;
// 连点节流：两次真正发往 DeepSeek 的请求至少隔这么久（跟随 ai-config 的 minRequestGapMs）。
// 这中间的点击直接用本地台词，既不会让气泡反复"……"，也不会重复花钱。
const AI_CLICK_GAP_FALLBACK_MS = 2000;
let lastAiClickAt = 0;
let aiStatus = null;     // 主进程 status() 快照
let aiSpeakToken = 0;    // 点击序号：新点击/切角色会作废旧请求的结果
let aiIdleToken = 0;     // 自言自语序号
const aiStreak = { area: null, count: 0, at: 0 };

function aiReady() {
  return !!(aiStatus && aiStatus.available);
}

function aiIdleIntervalMs() {
  const value = aiReady() && aiStatus ? Number(aiStatus.idleIntervalMs) : 0;
  return Number.isFinite(value) && value >= 30000 ? value : IDLE_DIALOGUE_INTERVAL_MS;
}

// AI 开启时用 ai-config 的 idleIntervalMs（默认 10 分钟）；关掉就回到原来的 5 分钟。
function currentIdleIntervalMs() {
  if (idleDialogue && Number.isFinite(idleDialogue.interval) && idleDialogue.interval > 0) {
    return idleDialogue.interval;
  }
  return IDLE_DIALOGUE_INTERVAL_MS;
}

function syncIdleInterval() {
  if (!idleDialogue) return;
  const next = aiIdleIntervalMs();
  if (idleDialogue.interval === next) return;
  idleDialogue.interval = next;
  idleDialogue.reset();
}

function canSpeakIdleDialogue() {
  if (!dialogueBubble || dialogueBubble.visible || !player || !player.skeleton || player.disposed
    || isSceneAsset() || isStillsAsset() || dragging || panelDrag || clickThrough || document.hidden
    || !panel.classList.contains("hidden") || !currentCharacter()) return false;
  const state = player.animationState || player.state;
  const entry = state && state.getCurrent && state.getCurrent(0);
  return !!(entry && entry.animation && entry.animation.name === idleName());
}

function nextClickStreak(area) {
  const key = area || "body";
  const stamp = Date.now();
  if (aiStreak.area === key && stamp - aiStreak.at <= AI_STREAK_WINDOW_MS) aiStreak.count++;
  else { aiStreak.area = key; aiStreak.count = 1; }
  aiStreak.at = stamp;
  return aiStreak.count;
}

function showLocalDialogue(role, area) {
  if (!dialogueBubble || !role) return null;
  return dialogueBubble.show(role.id, { kind: "click", area });
}

// 点击台词：先占位（气泡立刻出现"……"），AI 回来就替换；失败/超时就换成原台词。
async function speakClickLine(role, area, streak) {
  // Every click supersedes older replies, including throttled/local clicks.
  const token = ++aiSpeakToken;
  aiIdleToken++;
  if (!dialogueBubble || !role) return null;
  if (!aiReady() || !window.petAPI || typeof window.petAPI.aiLine !== "function") {
    return showLocalDialogue(role, area);
  }
  // 连点：距上次请求太近就这一句先用本地台词（彩蛋/表情累积不受影响）
  const gap = aiStatus && Number.isFinite(aiStatus.minRequestGapMs)
    ? aiStatus.minRequestGapMs : AI_CLICK_GAP_FALLBACK_MS;
  if (Date.now() - lastAiClickAt < gap) return showLocalDialogue(role, area);
  lastAiClickAt = Date.now();
  dialogueBubble.pending(role.id);
  const bubbleGeneration = dialogueBubble.generation;
  let result = null;
  try {
    result = await window.petAPI.aiLine({
      roleId: role.id,
      kind: "click",
      area: area || null,
      streak: streak || 1,
      mode: modeSelect.value,
      quietMs: Date.now() - lastRenderActivityAt,
      hour: new Date().getHours()
    });
  } catch (error) {
    result = null;
  }
  if (token !== aiSpeakToken || bubbleGeneration !== dialogueBubble.generation) return null;
  // 期间换了角色/造型、进了 CG、气泡被收掉：这次结果作废（主进程里已经进了缓存）
  if (!dialogueBubble.visible || dialogueBubble.roleId !== role.id || currentCharacter() !== role) return null;
  if (result && result.ok && result.text) {
    dialogueBubble.showText(role.id, result.text, { kind: "ai" });
    return result.text;
  }
  return showLocalDialogue(role, area);
}

// 闲置台词出口：先试 AI 自言自语，不行再播本地闲置台词。
// 播成功才算是"一次发言"，同时把闲置计时归零。
async function speakIdleDialogue() {
  const role = currentCharacter();
  if (!dialogueBubble || !role) return null;
  if (aiReady() && window.petAPI && typeof window.petAPI.aiLine === "function") {
    if (dialogueBubble.visible || !canSpeakIdleDialogue()) return null;
    const token = ++aiIdleToken;
    const bubbleGeneration = dialogueBubble.generation;
    let result = null;
    try {
      result = await window.petAPI.aiLine({
        roleId: role.id,
        kind: "idle",
        mode: modeSelect.value,
        quietMs: Date.now() - lastRenderActivityAt,
        hour: new Date().getHours()
      });
    } catch (error) {
      result = null;
    }
    if (token !== aiIdleToken || bubbleGeneration !== dialogueBubble.generation) return null;
    if (result && result.ok && result.text) {
      // 等网络的这几秒里可能已经有人点了它 / 换了造型
      if (!canSpeakIdleDialogue() || currentCharacter() !== role) return null;
      dialogueBubble.showText(role.id, result.text, { kind: "ai-idle" });
      lastIdleSpeakAt = Date.now();
      lastRenderActivityAt = Date.now();
      if (window.console && console.info) console.info("[pet] AI 自言自语:", role.id);
      return result.text;
    }
    if (!canSpeakIdleDialogue() || currentCharacter() !== role) return null;
  }
  const id = dialogueBubble.show(role.id, { kind: "idle" });
  if (id != null) {
    lastIdleSpeakAt = Date.now();
    lastRenderActivityAt = Date.now();
    if (window.console && console.info) console.info("[pet] 闲置台词:", id, role.id);
  }
  return id;
}

function startIdleWatchdog() {
  if (idleWatchdog || !idleDialogue) return;
  idleWatchdog = setInterval(() => {
    if (!idleDialogue.enabled) return;
    if (Date.now() - lastRenderActivityAt < currentIdleIntervalMs() + IDLE_DIALOGUE_GRACE_MS) return;
    // 到点但还没播（定时器被节流 / 上一轮 canSpeak 为 false 之后没再触发）：补一次并重新计时
    if (canSpeakIdleDialogue()) speakIdleDialogue();
    idleDialogue.reset();
    lastRenderActivityAt = Date.now();
  }, IDLE_DIALOGUE_WATCHDOG_MS);
}

function detectClickedDialogueArea(clientX, clientY, fallback) {
  const role = currentCharacter();
  if (!dialogueBubble || !role || !currentAsset) return null;
  const match = /spine_character_\d+_(\d+)/.exec(currentAsset.sourceBundle || "");
  try {
    const result = window.PetDialogue.detectDialogueArea(player, spine, dialogueBubble.data[role.id],
      clientX, clientY, {
        variant: match ? Number(match[1]) : null,
        yiff: /yiff/i.test(currentAsset.id),
        r15: !currentAsset.r18States,
        erect: r18Select.value === "ErectOn"
      });
    if (result.available) return result.area;
  } catch (error) {
    console.warn("[pet] 台词热区不可用，使用骨骼近邻：", error && error.message);
  }
  // Do not reinterpret arms or tails as chest/private dialogue regions.
  return ["head", "chest", "lower"].includes(fallback) ? fallback : null;
}

function desiredRenderFps() {
  const active = dragging || isSceneAsset()
    || Date.now() - lastRenderActivityAt < RENDER_IDLE_AFTER_MS;
  return active ? ACTIVE_RENDER_FPS : IDLE_RENDER_FPS;
}

function stopFrameLimiter(expectedPlayer) {
  if (expectedPlayer && frameLimiterPlayer !== expectedPlayer) return;
  clearTimeout(frameLimiterTimer);
  frameLimiterTimer = null;
  frameLimiterPlayer = null;
}

function installFrameLimiter(instance) {
  stopFrameLimiter();
  if (!instance || typeof instance.drawFrame !== "function") return;
  // 让 SpinePlayer 已经排队的下一次 RAF 自行结束，不再继续创建原生 60 FPS 循环。
  instance.stopRequestAnimationFrame = true;
  frameLimiterPlayer = instance;
  markRenderActivity();
  const tick = () => {
    if (frameLimiterPlayer !== instance || player !== instance || instance.disposed) {
      stopFrameLimiter(instance);
      return;
    }
    const startedAt = performance.now();
    frameLimiterFps = desiredRenderFps();
    try {
      instance.drawFrame(false);
    } catch (error) {
      console.warn("[pet] 限帧绘制失败：", error && error.message ? error.message : error);
    }
    const frameMs = 1000 / frameLimiterFps;
    const elapsed = performance.now() - startedAt;
    frameLimiterTimer = setTimeout(tick, Math.max(4, frameMs - elapsed));
  };
  // 给 SpinePlayer 原先已排队的 RAF 一帧时间，看见 stopRequestAnimationFrame 后停下。
  frameLimiterTimer = setTimeout(tick, 50);
}

// 默认启动状态：常规模式 + 李泰虎初始造型 + Idle
// 注意：模式/模型/表情/动画每次启动都强制回到默认值，不做持久化；
// 会被记住的只有：角色大小、开发者模式（含是否已解锁）、以及当前选中的角色。
// 角色属于"养哪一只"这种长期偏好，所以记住；模式/造型属于"当前什么形态"，每次重置。
const SETTINGS_KEY = "pet10423.settings.v3";

// 只保留真正会被读取的默认值：
//   mode/model 决定启动时选哪套造型；face 只在角色表里没配 base 时兜底
//   （实际各造型都会在 character.json 的 base.face 里写死，现在统一是 Face_01）
//   size 是滑块默认值。
// 表情/动画/R18 状态都不用在这里给默认值 —— 它们由造型自己的配置决定。
const DEFAULT = {
  mode: "sfw",
  model: "character_0",
  face: "Face_01",
  size: "100"
};

// 模式 -> 可选的模型 id。
// 不再写死：造型清单挂在「当前角色」上（characters/<id>/character.json），
// 这样以后加新角色只需要往那个文件里补一项，这里不用改。
// 没有安装角色时不提供历史李泰虎造型兜底，托盘设置/退出仍可使用。

function currentCharacter() {
  if (characterSelect && characterSelect.value) {
    const hit = characters.find(item => item.id === characterSelect.value);
    if (hit) return hit;
  }
  return characters[0] || null;
}

function modelsFor(mode) {
  const character = currentCharacter();
  if (!character) return [];
  return (mode === "r18" ? character.r18 : character.sfw) || [];
}

// 下拉框里的显示名。
// 注意：这是纯展示层，仅用于下拉项的文本；
// 所有内部逻辑（角色表 / 各角色的点击规则 / 存档）
// 一律以模型 id（character_0 等）为键，改名不会影响任何规则。
const MODEL_LABELS = {
  character_0: "李泰虎初始造型",
  character_1_r18: "李泰虎脱衣(R18)",
  character_2: "李泰虎五星造型",
  character_3: "新东黎",
  yiff_r18: "李泰虎培欲(R18)",
  hcg_10423: "李泰虎 CG场景(R18)",
  hcg_10423_extra: "李泰虎 CG场景2(R18)",
  lt_cg: "李泰虎CG静态图",
  bw_0: "白威初始造型",
  bw_1_r18: "白威脱衣(R18)",
  bw_2: "白威五星造型",
  bw_yiff_r18: "白威培欲(R18)",
  hcg_10444: "白威 CG场景(R18)",
  bw_cg: "白威CG静态图",
  bw_90711: "白威黑化",
  // Retired menu item; keep its catalog label for the shared layout resource.
  bw_armor: "白威装甲参考（内部资源）",
  bw_test: "白威未公开版本",
  dlw_0: "夏日达拉万初始造型",
  dlw_1_r18: "夏日达拉万脱衣(R18)",
  dlw_2: "夏日达拉万五星造型",
  dlw_yiff_r18: "夏日达拉万培欲(R18)",
  hcg_10438: "夏日达拉万 CG场景(R18)",
  dlw_cg: "夏日达拉万CG静态图",
  xu_0: "绚初始造型",
  xu_1_r18: "绚脱衣(R18)",
  xu_2: "绚五星造型",
  xu_yiff_r18: "绚培欲(R18)",
  hcg_10432: "绚 CG场景(R18)",
  xu_cg: "绚CG静态图",
  rfy_0: "任富言初始造型",
  rfy_1_r18: "任富言脱衣(R18)",
  rfy_2: "任富言五星造型",
  rfy_3: "任富言阴影中的支配",
  rfy_4_r18: "任富言脱衣",
  rfy_test: "任富言未公开版本",
  rfy_yiff_r18: "任富言培欲(R18)",
  hcg_10410: "任富言 CG场景(R18)",
  rfy_cg: "任富言CG静态图",
  qzz_0: "泉之助初始造型",
  qzz_1_r18: "泉之助脱衣(R18)",
  qzz_2: "泉之助五星造型",
  qzz_yiff_r18: "泉之助培欲(R18)",
  hcg_10430: "泉之助 CG场景(R18)",
  qzz_cg: "泉之助CG静态图",
  fmd_0: "法米多初始造型",
  fmd_1_r18: "法米多脱衣(R18)",
  fmd_2: "法米多五星造型",
  fmd_yiff_r18: "法米多培欲(R18)",
  hcg_10421: "法米多 CG场景(R18)",
  fmd_cg: "法米多CG静态图",
  blk_0: "喷射布莱克初始造型",
  blk_1_r18: "喷射布莱克脱衣(R18)",
  blk_2: "喷射布莱克五星造型",
  blk_3: "喷射布莱克 未公开版本",
  blk_yiff_r18: "喷射布莱克培欲(R18)",
  hcg_10418: "喷射布莱克 CG场景(R18)",
  blk_cg: "喷射布莱克CG静态图",
  anb_0: "阿努比洛斯初始造型",
  anb_1_r18: "阿努比洛斯脱衣(R18)",
  anb_2: "阿努比洛斯五星造型",
  anb_3: "阿努比洛斯 万灵涌动",
  anb_extra: "阿努比洛斯备用造型",
  anb_4_r18: "阿努比洛斯演出造型(R18)",
  anb_yiff_r18: "阿努比洛斯培欲(R18)",
  hcg_10401: "阿努比洛斯 CG场景(R18)",
  anb_cg: "阿努比洛斯CG静态图",
  pno_0: "彼亚诺斯初始造型",
  pno_1_r18: "彼亚诺斯脱衣(R18)",
  pno_2: "彼亚诺斯五星造型",
  pno_3: "彼亚诺斯短衣短裤",
  pno_4: "彼亚诺斯围裙造型",
  pno_yiff_r18: "彼亚诺斯培欲(R18)",
  hcg_10405: "彼亚诺斯 CG场景(R18)",
  pno_cg: "彼亚诺斯CG静态图"
};

let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new Error("设置内容不是对象");
  }
} catch (error) {
  // A partially written/corrupted preference must not prevent the renderer
  // from starting. Discard it and continue with the normal defaults.
  console.warn("[pet] 已忽略损坏的本地设置：", error && error.message ? error.message : error);
  localStorage.removeItem(SETTINGS_KEY);
}

// 任富言的动作 1、动作 4 和未公开版共用一个菜单入口。素材仍保持
// 原样，选项只决定实际加载哪一套原生骨架，避免运行时拼接纹理带来的风险。
const RFY_UNDRESS_ENTRY = "rfy_4_r18";
const RFY_UNDRESS_VARIANTS = Object.freeze([
  { id: "none", label: "什么都不穿", assetId: "rfy_4_r18" },
  { id: "ring", label: "添加环", assetId: "rfy_1_r18" },
  { id: "underwear", label: "穿内裤", assetId: "rfy_test" }
]);
let rfyUndressVariant = RFY_UNDRESS_VARIANTS.some(row => row.id === saved.rfyUndressVariant)
  ? saved.rfyUndressVariant
  : "none";

function isRfyUndressAsset(asset = currentAsset) {
  return !!(asset && RFY_UNDRESS_VARIANTS.some(row => row.assetId === asset.id));
}

function resolveMenuAsset(modelId) {
  if (modelId !== RFY_UNDRESS_ENTRY) return assets.find(item => item.id === modelId);
  const row = RFY_UNDRESS_VARIANTS.find(item => item.id === rfyUndressVariant)
    || RFY_UNDRESS_VARIANTS[0];
  return assets.find(item => item.id === row.assetId);
}

// ===== 换装开关分组（白威测试 / 白威装甲造型专用）=====
// 两类开关：
//   ARMOR_GROUPS（槽开关）—— 按槽名前缀匹配，关掉 = hook 摘掉该槽附件；
//     再勾上 = 还原 hook 并按当前皮肤重挂附件。用于"黑化的服装/装饰"这类叠加件。
//   SKIN_GROUPS（皮肤开关）—— 勾上 = applySkin 时把对应覆盖皮肤（如黑化身体
//     ALT_base_*）加进合并皮肤；取消 = 不加，setSlotsToSetupPose 自动回到
//     主骨架 default 皮肤的原始白毛附件。用于"整块替换外观"的部件。
// 顺序有讲究：先匹配到的组生效。
const ARMOR_GROUPS = [
  // 兜帽（含护颈 ALT_hood_neck，两者绑定为同一开关）
  { id: "hood", label: "兜帽", re: /^(ALT_Hood|ALT_hood|ALT_Fx_hood|ALT_Fx_head)/ },
  { id: "shoulder", label: "肩甲", re: /^cloth_armor_shoulder/ },
  { id: "arm", label: "臂甲 · 护手", re: /^cloth_(arm_|armor_arm_|hand_)/ },
  // 腰带（含腰部飘带 cloth_ace_*，两者绑定为同一开关）
  { id: "belt", label: "腰带 · 飘带", re: /^cloth_(belt|ace)/ },
  // 下装（裤子 + 鞋·护胫绑定为同一开关；cloth_underwear 黑化内裤也归这里）
  { id: "pants", label: "下装", re: /^cloth_(pants_|underwear|leg_|l_leg_armor)/ },
  // 黑化耳环：注入槽 cloth_ear_ring_r_1/r_2/l_1/l_2 是黑化件（勾选显示），
  // 原生白耳环挂在主骨架 r_3/r_4/l_3/l_4 槽（复用 r_1/r_2 的贴图）——
  // 组的 re 必须覆盖两类槽，hideWhenOn 声明"开启时要隐藏的原生件"
  { id: "earDark", label: "黑化耳环",
    re: /^cloth_ear_ring_(r_[1234]|l_[1234])/,
    hideWhenOn: /^cloth_ear_ring_(r_[34]|l_[34])$/ },
  // 生殖器是基础身体的部件，独立于裤子开关（穿上裤子也能自行决定显示与否）
  { id: "genital", label: "生殖器", re: /^(nake_gg_|Mosaic_)/ },
  { id: "eye", label: "红眼", re: /^Alt_base_face_eye/ },
  { id: "glow", label: "发光", re: /glow$/ },
  { id: "fx", label: "手臂特效", re: /^Fx_light_fist/ }
];

// 皮肤型开关：对应注入层注册的覆盖皮肤（黑化身体 / 黑化尾巴）
const SKIN_GROUPS = [
  { id: "darkBody", label: "黑化身体", skin: "DarkBody" },
  { id: "darkTail", label: "黑化尾巴", skin: "DarkTail" }
];

// 默认全开（含黑化身体/尾巴/耳环）。localStorage 里只存用户改过的开关。
const armorState = {};
for (const g of [...ARMOR_GROUPS, ...SKIN_GROUPS]) armorState[g.id] = true;
if (saved.armor && typeof saved.armor === "object") {
  for (const g of [...ARMOR_GROUPS, ...SKIN_GROUPS]) {
    if (typeof saved.armor[g.id] === "boolean") armorState[g.id] = saved.armor[g.id];
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    size: sizeSlider.value,
    devMode: devModeCheckbox.checked,
    devUnlocked: devUnlocked,
    displayZoom: displayZoom,
    displayOffsetX: displayOffsetX,
    displayOffsetY: displayOffsetY,
    character: characterSelect.value || null,
    rfyUndressVariant: rfyUndressVariant,
    armor: armorState,
    sideHead: sideHeadChoice
  }));
}

// R18 状态行：既要模型支持该参数，也要开启开发者模式
function updateR18RowVisibility() {
  const capable = !!(currentAsset && currentAsset.r18States);
  const dev = devModeCheckbox.checked;
  r18Row.classList.toggle("hidden", !(capable && dev));
  // 行数变化会改变面板高度：重新钳制一次，别让底边滑出窗口/屏幕
  renderPanelPos();
}

// 应用全局「显示范围」：缩放和位置都交给布局控制器换算成视口参数，
// 所有角色/造型通用（矢量缩放，画面不会糊）。
function applyDisplayAdjust() {
  if (!player || !currentAsset || !layoutController) return;
  layoutController.setAdjustment({
    zoom: displayZoom,
    offsetX: displayOffsetX,
    offsetY: displayOffsetY
  });
  positionHint(true);
}

// ===== 换装开关（开发者模式）=====
// 只对带 armor 标记的造型出现；勾选状态全局一份，存在 localStorage 里。
// 槽开关（ARMOR_GROUPS）勾选/取消都走 applySkin -> applyArmorGroups（hook 摘除/还原）；
// 皮肤开关（SKIN_GROUPS）勾选/取消只影响 applySkin 的皮肤组装。
const ALL_GROUPS = [...ARMOR_GROUPS, ...SKIN_GROUPS];

function buildArmorUI() {
  const capable = !!(currentAsset && currentAsset.armor);
  const dev = devModeCheckbox.checked;
  armorBox.classList.toggle("hidden", !(capable && dev));
  if (!capable) return;

  if (armorGrid.dataset.built !== "1") {
    armorGrid.replaceChildren();
    for (const g of ALL_GROUPS) {
      const item = document.createElement("label");
      item.className = "armor-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.group = g.id;
      cb.addEventListener("change", () => {
        // 手动勾选部件同样算接管：先取消规则的回退定时器，否则几秒后被默认部件冲掉
        resetProgression();
        armorState[g.id] = cb.checked;
        applySkin();
        updateArmorCount();
      });
      item.append(cb, document.createTextNode(" " + g.label));
      armorGrid.append(item);
    }
    armorGrid.dataset.built = "1";
  }
  armorGrid.querySelectorAll("input[data-group]").forEach(cb => {
    cb.checked = armorState[cb.dataset.group] !== false;
  });
  updateArmorCount();
  renderPanelPos();
}

function updateArmorCount() {
  const on = ALL_GROUPS.filter(g => armorState[g.id] !== false).length;
  armorCount.textContent = ` ${on}/${ALL_GROUPS.length}`;
}

function setAllArmor(on) {
  resetProgression();
  for (const g of ALL_GROUPS) armorState[g.id] = on;
  buildArmorUI();
  applySkin();
}

// ===== 两侧挂件可选（10401 阿努比洛斯的 Q 版 / 正常版狗头） =====
// 骨架把两侧挂件拆成了多套皮肤：Doll_l_* / Face_l_* 是 Q 版那侧，Doll_r_* / Face_r_* 是正常版那侧。
// 造型在 viewer_assets 里用 sideHeadOptions 声明可选组合，面板「角色造型」下方给一组单选框，
// 选择结果按造型 id 记在设置里。
let sideHeadChoice = (saved.sideHead && typeof saved.sideHead === "object" && !Array.isArray(saved.sideHead))
  ? Object.assign({}, saved.sideHead) : {};

function sideHeadOptionsFor() {
  const opts = currentAsset && currentAsset.sideHeadOptions;
  return Array.isArray(opts) && opts.length ? opts : null;
}

function currentSideHeadId() {
  const opts = sideHeadOptionsFor();
  if (!opts) return null;
  const want = sideHeadChoice[currentAsset.id];
  if (opts.some(option => option.id === want)) return want;
  return currentAsset.sideHeadDefault || opts[0].id;
}

// 侧头变体编号可以跟随主脸（sideHeadFollowFace）：皮肤名里写 {n}，
// 主脸 Face_04 → Face_l_04 / Face_r_04（Q版是 Doll_l_04 / Doll_r_04）。
// 某些编号在侧头里可能没有（两套数量不一样），那就退回 01——宁可保守，也不要整张脸消失。
function faceVariantNumber() {
  const m = /(\d+)\s*$/.exec(faceSelect.value || "");
  return m ? parseInt(m[1], 10) : null;
}

function sideHeadSkins() {
  const opts = sideHeadOptionsFor();
  if (!opts) return [];
  const hit = opts.find(option => option.id === currentSideHeadId());
  if (!hit || !Array.isArray(hit.skins)) return [];
  const follow = !!currentAsset.sideHeadFollowFace;
  const data = player && player.skeleton && player.skeleton.data;
  const exists = name => !!(data && data.findSkin && data.findSkin(name));
  const num = follow ? faceVariantNumber() : null;
  const pad = n => String(n).padStart(2, "0");
  const out = [];
  for (const tpl of hit.skins) {
    if (!tpl.includes("{n}")) { out.push(tpl); continue; }
    const candidates = num ? [num, 1] : [1];
    const name = candidates.map(n => tpl.replace("{n}", pad(n))).find(exists)
      || tpl.replace("{n}", pad(candidates[0]));
    out.push(name);
  }
  return out;
}

function buildSideHeadUI() {
  if (!sideHeadRow) return;
  const opts = sideHeadOptionsFor();
  if (!opts) { sideHeadRow.classList.add("hidden"); return; }
  const id = currentSideHeadId();
  if (sideHeadGroup.dataset.built !== currentAsset.id) {
    sideHeadGroup.replaceChildren();
    for (const option of opts) {
      const item = document.createElement("label");
      item.className = "radio-item";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "sideHead";
      radio.value = option.id;
      radio.addEventListener("change", () => {
        if (!radio.checked || !currentAsset) return;
        // 手选同样算接管：先清掉累积/回退定时器，否则几秒后会被打回基础状态
        resetProgression();
        sideHeadChoice[currentAsset.id] = option.id;
        saveSettings();
        applySkin();
      });
      item.append(radio, document.createTextNode(option.label));
      sideHeadGroup.append(item);
    }
    sideHeadGroup.dataset.built = currentAsset.id;
  }
  sideHeadGroup.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.checked = radio.value === id;
  });
  sideHeadRow.classList.remove("hidden");
  renderPanelPos();
}

function buildRfyVariantUI() {
  const character = currentCharacter();
  const capable = !!(character && character.id === "10410" && isRfyUndressAsset());
  rfyVariantBox.classList.toggle("hidden", !capable);
  if (!capable) {
    renderPanelPos();
    return;
  }
  if (rfyVariantGrid.dataset.built !== "1") {
    rfyVariantGrid.replaceChildren();
    for (const row of RFY_UNDRESS_VARIANTS) {
      const item = document.createElement("label");
      item.className = "armor-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.rfyVariant = row.id;
      cb.addEventListener("change", () => {
        if (!cb.checked) {
          cb.checked = true;
          return;
        }
        if (rfyUndressVariant === row.id) return;
        rfyUndressVariant = row.id;
        buildRfyVariantUI();
        saveSettings();
        const target = assets.find(item => item.id === row.assetId);
        if (target && target !== currentAsset) loadAsset(target);
      });
      item.append(cb, document.createTextNode(" " + row.label));
      rfyVariantGrid.append(item);
    }
    rfyVariantGrid.dataset.built = "1";
  }
  rfyVariantGrid.querySelectorAll("input[data-rfy-variant]").forEach(cb => {
    cb.checked = cb.dataset.rfyVariant === rfyUndressVariant;
  });
  renderPanelPos();
}

function applyDevMode() {
  // 静帧轮播没有骨架，表情/动画/状态这些选项一个都不适用，
  // 即使开发者模式打开也把它们收起来，别留一排空下拉。
  const on = devModeCheckbox.checked && !isStillsAsset();
  document.querySelectorAll(".dev-only").forEach(el => {
    el.classList.toggle("hidden", !on);
  });
  dispCtrl.classList.toggle("hidden", !(on && layoutController));
  updateR18RowVisibility();
  updateFaceRowsVisibility();
  // 装甲开关跟着开发者模式一起显隐，非装甲造型自动收起
  buildArmorUI();
  buildRfyVariantUI();
  buildSideHeadUI();
}

// 表情行 / C2 表情行：
//   普通造型 —— 只在开发者模式下出现（面板默认保持精简）
//   HCG 场景（配了 sceneSequence 的）—— 始终出现，方便手动挑人脸；
//     双人场景（带 faces2）额外出现 C2 表情
//   静帧轮播（静态图）—— 一律不出现：没有骨架/皮肤，表情下拉也是空的，
//     即使开发者模式开着也不占面板（applyDevMode 里收过一次，这里必须也拦住，
//     否则 dev 打开时会被下面这行重新显示出来）
function updateFaceRowsVisibility() {
  if (isStillsAsset()) {
    faceRow.classList.add("hidden");
    face2Row.classList.add("hidden");
    renderPanelPos();
    return;
  }
  const isScene = !!(currentAsset && currentAsset.sceneSequence && currentAsset.sceneSequence.length);
  const capable = !!(currentAsset && currentAsset.faces2);
  const dev = devModeCheckbox.checked;
  const show = isScene || dev;
  faceRow.classList.toggle("hidden", !show);
  face2Row.classList.toggle("hidden", !(show && capable));
  renderPanelPos();
}

// 按「当前角色 + 当前模式」重建造型下拉，并载入造型
function applyMode(mode, preferredModel) {
  let ids = modelsFor(mode);
  // 该角色在这个模式下没有任何造型时自动换到另一个模式，避免出现空下拉
  if (!ids.length) {
    mode = mode === "r18" ? "sfw" : "r18";
    modeSelect.value = mode;
    ids = modelsFor(mode);
  }
  if (!ids.length) return; // 角色表异常，保持现状

  // CG 场景标了 devOnly，非开发者模式下从下拉里剔除（走彩蛋才能进）
  const dev = devModeCheckbox.checked;
  const visible = ids.filter(id => {
    const item = assets.find(entry => entry.id === id);
    return item && (!item.devOnly || dev);
  });
  if (!visible.length) return;

  const previous = preferredModel || modelSelect.value;
  modelSelect.replaceChildren();
  for (const id of visible) {
    const asset = assets.find(item => item.id === id);
    if (asset) modelSelect.add(new Option(MODEL_LABELS[id] || asset.label, asset.id));
  }
  // 当前造型仍属于新列表则保留，否则回退到默认造型或列表首项
  const target = visible.includes(previous) ? previous
    : (visible.includes(DEFAULT.model) ? DEFAULT.model : visible[0]);
  modelSelect.value = target;
  const asset = resolveMenuAsset(target);
  // 已经是当前这套就不重复加载（开关开发者模式时会走到这里，重载会闪一下）
  if (asset && asset !== currentAsset) loadAsset(asset);
}

// 切换角色：造型清单整个换掉。旧角色的造型 id 一定不在新列表里，
// 所以显式指定"用新角色在当前模式下的第一个造型"
function applyCharacter(id) {
  const character = characters.find(item => item.id === id) || characters[0];
  if (!character) return;
  characterSelect.value = character.id;
  const ids = modelsFor(modeSelect.value);
  applyMode(modeSelect.value, ids.includes(DEFAULT.model) ? DEFAULT.model : ids[0]);
  saveSettings();
}

// ===== 空角色状态 =====
// 一个角色都没装载时，窗口里没有任何东西可画。必须给明确提示，否则用户只看到一片透明，
// 分不清"程序没启动"和"没有角色"。同时要强制整窗可点：透明区域默认穿透，
// 不主动上报命中状态的话，引导卡上的按钮点不到。
function setEmptyState(visible) {
  const show = Boolean(visible) && characters.length === 0;
  emptyStateVisible = show;
  if (emptyState) emptyState.classList.toggle("hidden", !show);
  const hintEl = document.getElementById("hint");
  if (hintEl) {
    hintEl.textContent = show
      ? "还没有安装角色 · 导入后自动加载"
      : "右键设置 · 拖动移动 · 单击触发动作";
  }
  if (show) {
    __lastPixelHit = true;
    window.petAPI.setMouseHit(true);
  }
  renderPanelPos();
}

// 角色下拉：没有角色时保留一个占位项，别留空下拉让人以为坏了
function renderCharacterOptions() {
  characterSelect.replaceChildren();
  if (!characters.length) {
    characterSelect.add(new Option("（未安装角色）", ""));
    characterSelect.disabled = true;
    return;
  }
  characterSelect.disabled = false;
  for (const character of characters) characterSelect.add(new Option(character.name, character.id));
}

// ===== 开发者模式隐藏入口 =====
// 「开发者模式」复选框默认不显示；连续点击「模式」两个字 10 次才解锁
// （2 秒内没有下一次点击就重新计数，避免误触累积）。解锁状态会被记住。
const DEV_TAP_TARGET = 10;
const DEV_TAP_WINDOW = 2000;
let devUnlocked = Boolean(saved.devUnlocked);
// 显示范围微调（开发者模式）：全局一份，由布局控制器换算成视口参数，所有角色/造型通用。
// displayZoom 走视口缩放（矢量，不会糊）；位置走 CSS 位移（相对窗口的百分比）。
let displayZoom = Number(saved.displayZoom) || 1;
let displayOffsetX = Number(saved.displayOffsetX) || 0;
let displayOffsetY = Number(saved.displayOffsetY) || 0;
let devTaps = 0;
let devTapAt = 0;
let devHintTimer = null;

function applyDevUnlock() {
  devRow.classList.toggle("hidden", !devUnlocked);
  renderPanelPos(); // 多出/少掉一行会改变面板高度，重新钳制一次
}

modeLabel.addEventListener("click", event => {
  // label 会把点击转发给里面的 select，不阻止的话每次连点都会弹出下拉
  event.preventDefault();
  const now = Date.now();
  devTaps = now - devTapAt > DEV_TAP_WINDOW ? 1 : devTaps + 1;
  devTapAt = now;
  if (devUnlocked || devTaps < DEV_TAP_TARGET) return;
  devUnlocked = true;
  devTaps = 0;
  applyDevUnlock();
  devModeCheckbox.checked = true;
  applyDevMode();
  saveSettings();
  devHint.classList.remove("hidden");
  if (devHintTimer) clearTimeout(devHintTimer);
  devHintTimer = setTimeout(() => devHint.classList.add("hidden"), 2600);
});

function setOptions(select, values, selected) {
  select.replaceChildren();
  for (const value of values) select.add(new Option(value, value));
  select.value = values.includes(selected) ? selected : values[0];
}

// 双人 CG：两张脸必须同时叠加，漏一张那个人就完全没有脸
// （default 皮肤里不含任何 face 槽，脸只能靠 C1_*/C2_* 皮肤贴上去）
function secondFaceName() {
  return currentAsset && currentAsset.faces2 ? face2Select.value : null;
}

// ===== 隐藏场景背景 =====
// CG 场景包的背景不是独立一张图，而是 36 个 BG* 插槽（BG 底板 / BG_Ground_front 前景草地 /
// 一堆 BG_particles_* 光点）。只要把这些插槽的附件清空，画面里就只剩角色本体。
//
// 为什么不能只清一次：动画的 AttachmentTimeline 每帧都会调用 slot.setAttachment() 把
// 背景重新贴回去（BG_fx_loop 就是专门驱动粒子的）。所以直接把插槽实例上的 setAttachment
// 换成「永远传 null」的版本 —— 之后不管动画怎么驱动、皮肤怎么重设，都贴不回来。
function installBackgroundMask(asset) {
  if (!player || !player.skeleton) return;
  const pattern = asset && asset.hideSlotPattern;
  if (!pattern) return;
  const re = new RegExp(pattern);
  let count = 0;
  player.skeleton.slots.forEach(slot => {
    if (!re.test(slot.data.name)) return;
    if (!slot.__bgMasked) {
      slot.__bgMasked = true;
      slot.__origSetAttachment = slot.setAttachment; // 留一份原方法，方便调试时还原
      const orig = slot.__origSetAttachment;
      slot.setAttachment = function () {
        return orig.call(this, null);
      };
    }
    slot.setAttachment(null);
    count++;
  });
  __c.bgMasked = count;
}

// 调试用：撤销背景遮罩，让背景重新显示
function removeBackgroundMask() {
  if (!player || !player.skeleton) return 0;
  let count = 0;
  player.skeleton.slots.forEach(slot => {
    if (!slot.__bgMasked) return;
    slot.setAttachment = slot.__origSetAttachment;
    delete slot.__bgMasked;
    delete slot.__origSetAttachment;
    slot.setToSetupPose();
    count++;
  });
  return count;
}

// 装甲部件分组见文件上方（靠 saved 初始化，必须在 saveSettings 之前定义）
function armorGroupOf(slotName) {
  for (const g of ARMOR_GROUPS) {
    if (g.re.test(slotName)) return g.id;
  }
  return null;
}

// 按勾选状态摘掉不需要的装甲部件。必须在 setSlotsToSetupPose 之后调用，
// 否则 setup pose 会把附件重新贴回来。
// 注意不能只做一次性 setAttachment(null)：任何 setAnimation（点击 Hit、切换动画）
// 都会 setToSetupPose 把附件重新挂回来。这里沿用 installBackgroundMask 的思路
// 给槽装 hook，把 setup/动画的重新挂载也拦成 null；重新勾选时再还原 hook 并
// 按当前皮肤重挂 setup 附件。
function applyArmorGroups() {
  if (!player || !player.skeleton || !currentAsset || !currentAsset.armor) return 0;
  let hidden = 0;
  const data = player.skeleton.data;
  for (const slot of player.skeleton.slots) {
    const gid = armorGroupOf(slot.data.name);
    if (!gid) continue;
    const g = ARMOR_GROUPS.find(x => x.id === gid);
    const on = armorState[gid] !== false;
    // 组内槽分两类：
    //   黑化件（不匹配 hideWhenOn）—— 勾选时显示，取消时摘除
    //   hideWhenOn 声明的原生槽（如白耳环）—— 勾选时隐藏，取消时恢复
    const isNative = g.hideWhenOn && g.hideWhenOn.test(slot.data.name);
    const shouldHide = isNative ? on : !on;
    if (shouldHide) {
      if (!slot.__armorMasked) {
        slot.__armorMasked = true;
        // __origSetAttachment 可能已被背景遮罩 hook 占用（存的是真正的原始方法），复用它
        slot.__origSetAttachment = slot.__origSetAttachment || slot.setAttachment;
        const orig = slot.__origSetAttachment;
        slot.setAttachment = function (a) {
          return orig.call(this, null);
        };
      }
      slot.setAttachment(null);
      hidden++;
    } else if (slot.__armorMasked) {
      // 恢复显示：还原原始 setter，并按当前皮肤重挂 setup 附件
      slot.setAttachment = slot.__origSetAttachment;
      const sd = slot.data;
      const si = data.slots.indexOf(sd);
      const skin = player.skeleton.skin;
      const att = sd.attachmentName && skin ? skin.getAttachment(si, sd.attachmentName) : null;
      slot.setAttachment(att);
      slot.__armorMasked = false;
    }
  }
  return hidden;
}

// ===== 互斥插槽对（同一部位做了两套附件）=====
// 有些 HCG 把同一部位画了两套附件，setup pose 里两套都挂着，靠每段动画的
// AttachmentTimeline 把「不用那一套」清成 null 来表示换另一套。比如泉之助 10430：
//   Act_01/02 清 c1_dick_b（用 a）、Act_03~06/Gacha 清 c1_dick_a（用 b）。
// 坑：清空是一次性的。某段动画清掉某套之后，后面换到「压根不碰这套」的段落时，
// 没有任何时间轴会把它挂回来 → 永久缺失（实测 Act_06 两套全空，画面里 gg 整个没有）。
// 这里给这类插槽装 hook，让状态永远自洽：
//   谁被挂上非空附件  → 伙伴让位（置空），避免两套叠在一起；
//   谁被清空且伙伴也空 → 从当前皮肤把伙伴重新挂回来。
// 数据侧在 characters/<id>/assets.json 里按造型声明：
//   "exclusiveSlotPairs": [["c1_dick_a", "c1_dick_b"]]
function slotSetupAttachment(slot, data) {
  if (!slot.data.attachmentName) return null;
  const skin = player.skeleton.skin;
  if (!skin) return null;
  return skin.getAttachment(data.slots.indexOf(slot.data), slot.data.attachmentName);
}

function installExclusiveSlots(asset) {
  const pairs = asset && asset.exclusiveSlotPairs;
  if (!pairs || !pairs.length || !player || !player.skeleton) return 0;
  const skeleton = player.skeleton;
  const data = skeleton.data;
  let count = 0;
  for (const pair of pairs) {
    const slots = (pair || [])
      .map(name => skeleton.slots.find(item => item.data.name === name))
      .filter(Boolean);
    if (slots.length < 2) continue;
    for (const slot of slots) {
      if (slot.__exclPair) continue; // 已装过（同一次加载里 applySkin 会多次调用）
      slot.__exclPair = slots;
      // 别的 hook（背景遮罩 / 装甲分组）可能已经把真·原始方法挪到 __origSetAttachment
      slot.__exclOrig = slot.__origSetAttachment || slot.setAttachment;
      const orig = slot.__exclOrig;
      const partners = slots.filter(item => item !== slot);
      slot.setAttachment = function (att) {
        orig.call(this, att);
        for (const partner of partners) {
          if (!partner.__exclOrig) continue;
          if (att) {
            // 本槽显示 → 伙伴让位（走伙伴的原始方法，不会递归回来）
            partner.__exclOrig.call(partner, null);
          } else if (!partner.attachment) {
            // 本槽被清空、伙伴也空着 → 把伙伴从当前皮肤挂回来，别让这一对全空
            const back = slotSetupAttachment(partner, data);
            if (back) partner.__exclOrig.call(partner, back);
          }
        }
      };
      count++;
    }
  }
  return count;
}

// ===== 伴生骨架注入 =====
// 引擎在 assets/inject-companion.js（与诊断工具共用同一份实现），签名：
//   await injectCompanionSkeleton(player, cfg)
//（renderer.html 在 renderer.js 之前加载 assets/inject-companion.js）

// ===== 受击脸红补丁（blushSlots）=====
// 有的骨架把红晕做成独立槽（10401：face_a_01_red / face_b_01_red / face_c_01_red），
// 但附件只写在 *_01 那张脸皮肤里。主脸或侧头一旦切到 02 以后的变体，
// Hit_face 想挂红晕时在当前皮肤里查不到同名附件，整层红晕就消失了。
// 这里把附件从任意皮肤里借出来、合并进当前皮肤，动画的时间轴就能照常把它挂上。
// 只在造型/选项声明了 blushSlots 时才做（Q 版小圆头没有对应红晕贴图，不能借成人的）。
function blushSlotNames() {
  const out = [];
  const push = list => {
    for (const name of (Array.isArray(list) ? list : [])) {
      if (!out.includes(name)) out.push(name);
    }
  };
  if (currentAsset) push(currentAsset.blushSlots);
  const opts = sideHeadOptionsFor();
  if (opts) {
    const hit = opts.find(option => option.id === currentSideHeadId());
    if (hit) push(hit.blushSlots);
  }
  return out;
}

// 只有受击动画播放期间才把红晕附件合进来；动画结束（或切到别的动画）就撤掉，
// 否则红晕会一直挂在脸上（时间轴把透明度停在中间值时尤其明显）。
let blushActive = false;
let blushTimer = null;

function blushAnims() {
  return (currentAsset && currentAsset.blushAnims) || ["Hit_face"];
}

function addBlushOverlays(skin) {
  if (!blushActive) return;
  const names = blushSlotNames();
  if (!names.length) return;
  const skel = player.skeleton;
  for (const name of names) {
    const index = skel.slots.findIndex(slot => slot.data.name === name);
    if (index < 0 || skin.getAttachment(index, name)) continue;
    for (const source of skel.data.skins) {
      const att = source.getAttachment(index, name);
      // 这个 spine 版本的 Skin 没有 addAttachment，只有 setAttachment(slotIndex, name, att)
      if (att) { skin.setAttachment(index, name, att); break; }
    }
  }
}

function updateBlushState(name) {
  clearTimeout(blushTimer);
  blushTimer = null;
  blushActive = !!blushSlotNames().length && blushAnims().includes(name);
  if (!blushActive) return;
  const anim = player.skeleton.data.findAnimation(name);
  const ms = Math.max(300, Math.round(((anim && anim.duration) || 1) * 1000) + 120);
  blushTimer = setTimeout(() => {
    blushTimer = null;
    if (!blushActive) return;
    blushActive = false;
    applySkin();   // 重建皮肤并回 setup pose，把残留的红晕附件清掉
  }, ms);
}

function applySkin() {
  if (!player || !player.skeleton || !player.skeleton.data || !currentAsset) return;
  const parts = ["default"];
  // 常驻脸（baseSkins）：有的骨架里只有「某几个角色」的脸皮肤，
  // 比如 hcg_10421 的 C1_Face_01/06 只给 F1 上脸、C1_Face_03/04/05 只给 F2 上脸，
  // 默认皮肤里没有 F1 的脸。只按下拉选一张的话，选到 F2 的脸时 F1 就整张脸消失。
  // 这里先垫一张常驻脸，下拉里选的那张后加、覆盖在上面。
  // 常驻皮肤：优先用当前选中的可选项（10401 两侧狗头的 Q 版/正常版），否则退回 baseSkins
  const headSkins = sideHeadSkins();
  for (const name of (headSkins.length ? headSkins : (currentAsset.baseSkins || []))) {
    if (player.skeleton.data.findSkin(name)) parts.push(name);
  }
  parts.push(faceSelect.value);
  const face2 = secondFaceName();
  if (face2) parts.push(face2);
  if (currentAsset.r18States) parts.push(r18Select.value);
  // 换装的皮肤型开关（黑化身体/尾巴/耳环）：勾选的黑化覆盖皮肤排到最后，
  // 覆盖同槽的原生附件；取消时不加入，setSlotsToSetupPose 自动回到原生白毛
  if (currentAsset.armor) {
    for (const sw of SKIN_GROUPS) {
      if (armorState[sw.id] !== false && player.skeleton.data.findSkin(sw.skin)) parts.push(sw.skin);
    }
  }
  // 场景皮肤：部分 HCG（如任富言 10410）的 spine 文件里有按阶段拆分的
  // Slot_01~08 / Gacha 皮肤，不叠加的话鞭子、精液、脸红等效果不会显示。
  const animName = animationSelect.value;
  const sceneSkins = currentAsset.sceneSkins && currentAsset.sceneSkins[animName];
  if (sceneSkins) {
    for (const skinName of sceneSkins) {
      if (player.skeleton.data.findSkin(skinName)) parts.push(skinName);
    }
  }
  const skin = new spine.Skin("desktop:" + parts.join("+"));
  for (const name of parts) {
    const source = player.skeleton.data.findSkin(name);
    if (source) skin.addSkin(source);
  }
  addBlushOverlays(skin);
  player.skeleton.setSkin(skin);
  // 互斥插槽对要在 setSlotsToSetupPose 之前装好：setup 会把两套附件都挂上，
  // hook 之后可保证同一时刻只留一套（详见 installExclusiveSlots 注释）
  installExclusiveSlots(currentAsset);
  player.skeleton.setSlotsToSetupPose();
  // setSlotsToSetupPose 会把 setup 里的背景附件重新贴回来（被 hook 拦成 null），
  // 这里再兜一次，确保任何换装入口之后背景都是隐藏状态
  installBackgroundMask(currentAsset);
  // 装甲造型：setup pose 会把所有装甲贴回来，这里按勾选状态再摘一遍
  applyArmorGroups();
  // 注意：这里不要再调 player.setViewport() —— 实测部件开关（有槽被摘成 null）后
  // 重算视口会得到无效视口，画面整体消失且无报错。视口重算只在注入完成后的
  // success 回调里做一次（装甲全挂、包围盒最全），之后的部件开关不再重算。
  saveSettings();
}

function playAnimation(name, loop = true) {
  __c.anim++;
  if (!player || !player.skeleton || !player.skeleton.data ||
      !player.skeleton.data.findAnimation(name)) return;
  if (layoutController) layoutController.setAnimationName(name);
  player.setAnimation(name, loop);
  animationSelect.value = name;
  updateBlushState(name);
  applySkin();
  saveSettings();
}

// ===== 点击累积规则：按角色隔离 =====
// 规则不再写在代码里，而是放在 characters/<id>/character.json 的
//   characters[i].models[造型id] = { base: {...}, rules: {...} }
// 取规则时**只看当前角色**，查不到就是"这套造型没有表情累积规则"。
// 这样后续加别的角色时，它不会莫名其妙继承李泰虎的规则；
// 新角色想要规则，必须在自己的 models 里写一份。
//   rules 的 key 是部位名，未命中具体部位时回退到 default
//   threshold 连点多少次触发 / face、r18 触发后切到什么 / revertDelayMs 多久后回 base
function modelConfig(modelId) {
  const character = currentCharacter();
  const id = modelId || (currentAsset && currentAsset.id);
  if (!character || !id) return null;
  return (character.models && character.models[id]) || null;
}

// 当前造型的累积规则；没有就返回 null（不参与表情累积）
function progressionFor() {
  const config = modelConfig();
  return config && config.rules ? config : null;
}

// 指定造型的基础状态（载入时用、超时回退用）
function baseFor(modelId) {
  const config = modelConfig(modelId);
  return (config && config.base) || null;
}

// 「白威测试」的默认换装参数（勾选造型即应用；点击规则超时回退也回到这套）
// 与用户确认的默认面板一致：9/12 —— 不含 下装 / 生殖器 / 黑化身体
const BW_TEST_DEFAULTS = {
  hood: true, shoulder: true, arm: true, belt: true,
  pants: true, earDark: true, genital: false, eye: false,
  glow: true, fx: true, darkBody: false, darkTail: true
};
function applyBwTestDefaults() {
  Object.assign(armorState, BW_TEST_DEFAULTS);
}

// ===== 隐藏彩蛋（同样是角色私有的） =====
// 配置在 character.json 的 secret；当前角色没有配置就没有彩蛋。
// 李泰虎这条：CG 场景在下拉里被隐藏（devOnly，只有开发者模式能直接选），
// 普通使用的入口是彩蛋 —— 成人模式 + 培欲造型 + 已经切到 Face_03 之后，
// 再连点 10 次下肢就直接进 CG 场景；在 CG 里把 7 个阶段点完，等 5 秒自动回培欲。
// 开发者模式下不走彩蛋（下拉里本来就能选，否则调试表情累积时会被打断）。
function cgSecret() {
  const character = currentCharacter();
  return (character && character.secret) || null;
}
let cgReturnTimer = null;

function cancelScenePlayback() {
  scenePlaybackGeneration++;
  sceneAutoPlaying = false;
  clearTimeout(sceneHoldTimer);
  sceneHoldTimer = null;
  clearTimeout(cgReturnTimer);
  cgReturnTimer = null;
}

let clickCounts = {};
let progressionTimer = null;

function resetProgression() {
  clickCounts = {};
  clearTimeout(progressionTimer);
  progressionTimer = null;
}

// 切回模型基础状态
function revertToBase(cfg) {
  if (!cfg || !cfg.base) return;
  // 白威测试：先把换装参数回到默认，再让下面的 applySkin 按默认重建
  if (currentAsset && currentAsset.id === "bw_test") applyBwTestDefaults();
  if (cfg.base.face) setFaceByName(cfg.base.face);
  if (cfg.base.r18) setR18ByName(cfg.base.r18);
  buildArmorUI();
}

// 切换表情（程序调用不触发 onchange，避免被"手动切换"逻辑重置计数）
function setFaceByName(name) {
  const exists = [...faceSelect.options].some(option => option.value === name);
  if (!exists) return false;
  faceSelect.value = name;
  applySkin();
  return true;
}

// 切换 R18 状态（同样不触发 onchange）
function setR18ByName(name) {
  if (!currentAsset || !currentAsset.r18States) return false;
  const exists = [...r18Select.options].some(option => option.value === name);
  if (!exists) return false;
  r18Select.value = name;
  applySkin();
  return true;
}

// 是否满足"进 CG 场景"的彩蛋条件：
// 非开发者模式 + 培欲(R18) + 当前已经是 Face_03 + 本次又是下肢达标
function isCgSecretReady(ruleKey) {
  const secret = cgSecret();
  if (!secret) return false;                 // 这个角色没有彩蛋
  if (devModeCheckbox.checked) return false; // 开发者模式下拉里直接选，不用彩蛋
  if (!currentAsset || currentAsset.id !== secret.from) return false;
  if (ruleKey !== secret.region) return false;
  return faceSelect.value === secret.face;
}

// 下拉里本来没有 CG 这一项（devOnly），彩蛋进入时临时补一个，
// 好让用户看得到当前到底是哪一套素材
function ensureModelOption(asset) {
  const exists = [...modelSelect.options].some(option => option.value === asset.id);
  if (exists) return;
  modelSelect.add(new Option(MODEL_LABELS[asset.id] || asset.label, asset.id));
}

function enterCgScene() {
  const secret = cgSecret();
  if (!secret) return false;
  const target = assets.find(item => item.id === secret.to);
  if (!target) return false;
  clearTimeout(cgReturnTimer);
  cgReturnTimer = null;
  resetProgression(); // 清掉"回基础表情"的定时器，避免和场景跳转打架
  ensureModelOption(target);
  modelSelect.value = target.id;
  loadAsset(target);
  saveSettings();
  return true;
}

// CG 里把阶段都点完之后，等一会儿自动回到培欲造型。
// 默认用角色配置里的 returnDelayMs；最后一段带 then（如 Act_06 -> BG_fx_loop）时
// 由调用方把 thenHoldMs 传进来，保证"then 循环停多久"和"多久后回退"是同一个数。
function armCgReturn(delayMs) {
  const secret = cgSecret();
  if (!secret) return;
  clearTimeout(cgReturnTimer);
  const ms = Number(delayMs) > 0 ? Number(delayMs) : secret.returnDelayMs;
  const generation = scenePlaybackGeneration;
  const asset = currentAsset;
  cgReturnTimer = setTimeout(() => {
    if (generation === scenePlaybackGeneration && currentAsset === asset) returnFromCgScene();
  }, ms);
}

function returnFromCgScene() {
  cgReturnTimer = null;
  const secret = cgSecret();
  if (!secret) return;
  const back = assets.find(item => item.id === secret.back);
  if (!back) return;
  resetProgression();
  // 重建下拉：非开发者模式下 CG 本来就不在列表里，这一步顺手去掉临时补的那一项
  applyMode(modeSelect.value, back.id);
  saveSettings();
}

// 每次点击后累积计数，达标切换状态并在延时后切回基础状态
// "连续"语义：点击其他部位会重置其它部位的计数
function handleClickProgression(region) {
  const cfg = progressionFor();
  if (!cfg) return null; // 该造型没配规则（或属于别的角色）：不参与表情累积

  const ruleKey = cfg.rules[region] ? region : "default";
  const rule = cfg.rules[ruleKey];
  if (!rule) return null;

  // 只累加当前部位的计数，其余部位清零
  for (const key of Object.keys(clickCounts)) {
    if (key !== ruleKey) clickCounts[key] = 0;
  }
  clickCounts[ruleKey] = (clickCounts[ruleKey] || 0) + 1;
  if (clickCounts[ruleKey] < rule.threshold) return null;

  // 达标：清零并切换表情 / R18 状态
  clickCounts = {};
  // 彩蛋优先：培欲造型已经切到 Face_03 之后，再连点 10 次下肢 -> 直接进 CG 场景
  if (isCgSecretReady(ruleKey)) {
    enterCgScene();
    const secret = cgSecret();
    return secret ? secret.to : null;
  }
  // 规则可携带部件参数（白威测试）：先更新勾选状态，再让下面的
  // setFaceByName/setR18ByName 内部的 applySkin 按"新勾选状态"重建
  if (rule.armor && currentAsset && currentAsset.id === "bw_test") {
    Object.assign(armorState, rule.armor);
    buildArmorUI();
  }
  const faceChanged = setFaceByName(rule.face);
  if (rule.r18) setR18ByName(rule.r18);
  if (!faceChanged) return null;

  // 重新计时，等待后切回该模型的基础状态
  clearTimeout(progressionTimer);
  progressionTimer = setTimeout(() => {
    progressionTimer = null;
    revertToBase(cfg);
  }, rule.revertDelayMs || 10000);
  return rule.face;
}

// 部位 -> 动画的映射（按优先级尝试，模型没有该动画则回退）
const REGION_ANIMATIONS = {
  head: ["Hit_face", "Hit", "Hit_all"],
  chest: ["Hit", "Hit_all", "Hit_face"],
  arm: ["Hit", "Hit_all", "Hit_face"],
  tail: ["Hit_all", "Hit", "Hit_face"],
  lower: ["Hit_all", "Hit", "Hit_face"]
};

// 各部位的关键骨骼锚点（用骨骼名匹配，取最近的一根判定部位）
// 注意：不同包的骨骼命名大小写不一致（如 character_* 是 head/chest/hip，yiff_r18 是 Head/Chest/Hip），
// 因此匹配时统一小写比较。
// 部位 -> 该部位包含的骨骼名（命中规则：取光标最近的骨骼所属部位）
// ⚠️ 同名不同写法都要列：不同造型的骨骼命名风格不统一。
//    · 大多数角色是「小写下划线」：leg_l_2 / tail_1 / gg_normal_1
//    · 10432「绚」的培欲造型是另一套「驼峰无下划线」：LegL2 / Ball / Tail / ArmR
//      少了这些别名，那套造型的点击会全部被判成 head，下肢规则和彩蛋都不触发
//    · Hip / Chest / Head 这类首字母大写的，靠下面的小写索引就能匹配，不用重复列
const REGION_BONES = {
  head: ["head", "face_mesh_1", "face_mesh_2", "ear_l_1", "ear_r_1", "hair_1", "eyes_control",
         "ear_r", "ear_l", "face_eyes", "face_mouth",
         "Head2", "Face", "EarL", "EarL2", "EarR", "EarR2", "Hair"],
  chest: ["chest", "shoulder_l", "shoulder_r", "nip_r", "nip_l", "cloth_detail_chest_1",
          "Chest"],
  arm: ["arm_l_1", "arm_l_2", "arm_r_1", "arm_r_2", "hand_r_1", "hand_r_2",
        "ArmL", "ArmL2", "ArmL3", "ArmL4", "ArmR", "ArmR2", "ArmR3", "ArmR4",
        "Arm_L1", "Arm_L2", "Arm_R1", "Arm_R2",
        "Hand_L", "Hand_R", "Hand_L2", "Hand_R2"],
  tail: ["tail_1", "tail_2", "tail_3", "tail_4",
         "Tail", "Tail2", "Tail3"],
  lower: ["hip", "leg_l_2", "leg_r_2", "gg_hard_1", "gg_normal_1", "balls_1",
          "LegL", "LegL2", "LegL3", "LegL4", "LegR", "LegR2", "LegR3", "LegR4",
          "Ball", "Ball2", "Ball3", "Ball4",
          "Leg_L1", "Leg_L2", "Leg_R1", "Leg_R2",
          "Knot", "Dicks", "Dick_group"]
};

// Several rigs place two control bones at exactly the same world position
// (for example hip/tail root and chest/arm root). A plain "first one wins"
// nearest-bone search therefore changes result when the array order changes.
// Prefer the anatomically more specific interactive region only for ties;
// ordinary nearest-distance matches are unchanged.
const REGION_TIE_PRIORITY = Object.freeze({
  lower: 5,
  arm: 4,
  head: 3,
  tail: 2,
  chest: 1
});
const REGION_TIE_EPSILON = 0.001;

// 各造型载入时的基础状态现在跟着角色走 —— 见 character.json 的 models[id].base，
// 由 baseFor() 读取；没配的造型（以及别的角色的造型）用全局默认 DEFAULT.face。

// 屏幕坐标 -> 骨骼坐标
// SpinePlayer 的 currentViewport 是"骨骼坐标系下的可视区域"，x/y 为左下角
function screenToSkeleton(clientX, clientY) {
  if (!player) return null;
  const canvas = document.querySelector("#player canvas");
  const vp = player.currentViewport || player.viewport;
  if (!canvas || !vp) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  // 换算到 canvas 像素坐标（兼容 DPR 缩放）
  const px = (clientX - rect.left) * (canvas.width / rect.width);
  const py = (clientY - rect.top) * (canvas.height / rect.height);
  return {
    x: vp.x + (px / canvas.width) * vp.width,
    // 骨骼坐标 y 轴向上，屏幕 y 轴向下，需要翻转
    y: vp.y + (1 - py / canvas.height) * vp.height
  };
}

// 判定点击落在哪个部位：取距离最近的骨骼锚点
function detectRegion(clientX, clientY) {
  if (!player || !player.skeleton || !Array.isArray(player.skeleton.bones)) return null;
  const point = screenToSkeleton(clientX, clientY);
  if (!point) return null;
  const skeleton = player.skeleton;
  // 预建 小写名 -> 骨骼 的索引（骨骼命名大小写不统一）
  if (!skeleton.__boneIndex) {
    skeleton.__boneIndex = {};
    for (const bone of skeleton.bones) {
      const key = String(bone.data.name).toLowerCase();
      if (!skeleton.__boneIndex[key]) skeleton.__boneIndex[key] = bone;
    }
  }
  let best = null;
  let bestDist = Infinity;
  for (const region of Object.keys(REGION_BONES)) {
    for (const boneName of REGION_BONES[region]) {
      const bone = (skeleton.findBone && skeleton.findBone(boneName))
        || skeleton.__boneIndex[boneName.toLowerCase()];
      if (!bone) continue;
      const d = Math.hypot(bone.worldX - point.x, bone.worldY - point.y);
      if (d + REGION_TIE_EPSILON < bestDist ||
          (Math.abs(d - bestDist) <= REGION_TIE_EPSILON &&
           (REGION_TIE_PRIORITY[region] || 0) > (REGION_TIE_PRIORITY[best] || 0))) {
        bestDist = d;
        best = region;
      }
    }
  }
  __lastHit = { region: best, point, distance: Math.round(bestDist) };
  return best;
}

/**
 * 当前模型的"待机 / 循环"动画名。
 * 角色包都有 Idle；但 HCG 场景包没有 Idle（只有 Act_XX / BG_fx_loop），
 * 若继续硬编码 "Idle"，SpinePlayer 会在构造时抛
 * "Animation does not exist in skeleton: Idle"，整个模型渲染不出来（画面全黑）。
 * 所以统一走这里：有 Idle 用 Idle，否则用 assets.json 里该造型的 loopAnimation，
 * 再退化用动画列表第一项。
 */
function idleName() {
  const list = (currentAsset && currentAsset.animations) || [];
  const firstSceneStep = currentAsset && currentAsset.sceneSequence && currentAsset.sceneSequence[0];
  if (firstSceneStep && list.includes(firstSceneStep.animation)) return firstSceneStep.animation;
  const preferred = currentAsset && currentAsset.loopAnimation;
  if (preferred && list.includes(preferred)) return preferred;
  if (list.includes("Idle")) return "Idle";
  return list[0] || "Idle";
}

// 按部位挑选该模型实际拥有的动画
function animationForRegion(region) {
  const available = (currentAsset && currentAsset.animations) || [];
  const candidates = REGION_ANIMATIONS[region] || REGION_ANIMATIONS.chest;
  return candidates.find(name => available.includes(name))
    || available.find(name => name !== idleName())
    || idleName();
}

// 部位感知版：点击头部播 Hit_face、躯干播 Hit、下半身播 Hit_all
function playReactionAt(clientX, clientY, capturedRegion) {
  // Capture the region on pointerdown. Animated bones can move noticeably
  // before pointerup, which previously turned hip clicks into tail clicks and
  // arm clicks into chest clicks on fast-moving rigs.
  const region = capturedRegion !== undefined
    ? capturedRegion
    : detectRegion(clientX, clientY);
  playAnimation(animationForRegion(region), false);
  // 播完回到 Idle（沿用原有衔接逻辑）
  // 必须连 skeleton 一起判空：player 在 new SpinePlayer() 时就已赋值，
  // 但 animationState 要等资源加载完才存在，加载窗口内调 addAnimation 会抛错
  if (typeof player !== "undefined" && player && player.skeleton) {
    const state = player.animationState || player.state;
    const entry = state && state.getCurrent ? state.getCurrent(0) : null;
    if (entry) entry.listener = { complete: () => { animationSelect.value = idleName(); saveSettings(); } };
    player.addAnimation(idleName(), true, 0);
    if (typeof player.play === "function" && player.paused) player.play();
  }
  return region;
}

// ===== CG 场景包（HCG）的点击行为 =====
// HCG 只有 Act_XX 这类场景动画，既没有 Idle 也没有 Hit，所以不能播"反应动画"。
// 对这类模型，点击改成按顺序切换到下一个 Act / Act_NN。
function isSceneAsset() {
  const list = (currentAsset && currentAsset.animations) || [];
  return list.length > 0 && !list.includes("Idle");
}

// ===== 静帧轮播（kind: "stills"）=====
// 白威CG静态图 这类"造型"没有骨架，就是一组现成的静态大图（2048x1152 差分图 9 张）。
// 表现方式：自动按帧轮播，点击手动切下一张。和 Spine 播放器互斥。
function isStillsAsset(asset = currentAsset) {
  return !!(asset && asset.kind === "stills" && Array.isArray(asset.frames) && asset.frames.length);
}

// 图片用 object-fit: contain 显示，元素本身铺满窗口、真实画面只占中间一条。
// 命中判定必须按"真实画面矩形"算，不能直接拿 img 的 rect，否则整窗都能点。
function stillsContentRect() {
  const img = document.getElementById("stillsImg");
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const box = img.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top + (box.height - h) / 2,
    width: w,
    height: h
  };
}

function showStillsFrame(index) {
  const asset = currentAsset;
  if (!isStillsAsset(asset)) return null;
  const total = asset.frames.length;
  stillsIndex = ((index % total) + total) % total;
  const img = document.getElementById("stillsImg");
  if (!img) return null;
  const url = "assets/" + asset.frames[stillsIndex];
  if (img.getAttribute("src") !== url) img.src = url;
  return stillsIndex;
}

function stopStillsAuto() {
  clearInterval(stillsTimer);
  stillsTimer = null;
}

function startStillsAuto() {
  stopStillsAuto();
  const asset = currentAsset;
  if (!isStillsAsset(asset) || asset.loop === false) return;
  // 下限 200ms：配置写错成 0 或负数时不要变成死循环狂切
  const ms = Math.max(200, Number(asset.frameMs) || 2400);
  stillsTimer = setInterval(() => showStillsFrame(stillsIndex + 1), ms);
}

// 点击 / 调试：切下一张，并把轮播计时重新起算
function advanceStills() {
  if (!isStillsAsset()) return null;
  const next = showStillsFrame(stillsIndex + 1);
  startStillsAuto();
  return next;
}

function hideStills() {
  stopStillsAuto();
  const box = document.getElementById("stills");
  if (box) box.classList.add("hidden");
  const img = document.getElementById("stillsImg");
  if (img) img.removeAttribute("src");
  stillsPreload = [];
}

function loadStills(asset) {
  if (dialogueBubble) dialogueBubble.hide();
  cancelScenePlayback();
  // A pending SpinePlayer success callback must not take ownership again after
  // we have switched to the DOM-based stills renderer.
  assetLoadGeneration++;
  clearTimeout(pixelHitVerifyTimer);
  pixelHitVerifyTimer = null;
  // A previous WebGL model may have fallen back to whole-window hit testing.
  // Stills have their own reliable content-rectangle test, so always restore it.
  pixelHitEnabled = true;
  __lastPixelHit = null;
  // 先彻底拆掉 Spine 播放器：留着会继续渲染、还会抢走 #player 里的 canvas
  stopFrameLimiter();
  if (layoutController) {
    layoutController.dispose();
    layoutController = null;
  }
  if (player) {
    player.dispose();
    player = null;
  }
  const holder = document.getElementById("player");
  if (holder) holder.replaceChildren();
  // 静帧没有骨架：提示条回到窗口底部居中，不要停在上一套造型的脚底位置
  positionHint(true);
  currentAsset = asset;
  buildRfyVariantUI();
  sceneStepIndex = 0;
  resetProgression();
  // 静帧没有表情 / 动画 / R18 状态，把这几个下拉清空并收起对应行
  faceSelect.replaceChildren();
  face2Select.replaceChildren();
  animationSelect.replaceChildren();
  r18Select.replaceChildren();
  // applyDevMode 内部已经会刷新 R18 状态行和「对方表情」行的显隐，
  // 不需要在它前面重复调那两个函数
  applyDevMode();
  stillsIndex = 0;
  const box = document.getElementById("stills");
  if (box) box.classList.remove("hidden");
  const hintEl = document.getElementById("hint");
  if (hintEl) hintEl.textContent = "右键设置 · 拖动移动 · 单击切下一张";
  showStillsFrame(0);
  // 预加载其余帧：不预载的话第一次切到某张会有短暂空白
  for (const frame of asset.frames) {
    const pre = new Image();
    pre.src = "assets/" + frame;
    stillsPreload.push(pre);
  }
  startStillsAuto();
  // Returning from an auto-expanded Spine character to a still image must
  // also restore the normal/debug window width.
  applyWindowSize();
  saveSettings();
  return asset.id;
}

// 取该模型的 Act 列表，按数字排序（Act_10 要排在 Act_9 之后，字符串排序会错）
function actSequence() {
  const list = (currentAsset && currentAsset.animations) || [];
  return list
    .filter(name => /^Act[_-]?\d+$/i.test(name))
    .sort((a, b) => parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10));
}

// 点击 -> 播下一个 Act（循环回到第一个）
function cycleAct() {
  // 手动点了一次就退出"进入后自动播一遍"的模式，改由点击逐段推进
  cancelScenePlayback();
  const configured = (currentAsset && currentAsset.sceneSequence) || [];
  if (configured.length) {
    return playSceneStep((sceneStepIndex + 1) % configured.length);
  }
  const acts = actSequence();
  if (!acts.length || !player) return null;
  const idx = acts.indexOf(animationSelect.value);
  const next = acts[(idx + 1) % acts.length];
  animationSelect.value = next;
  playAnimation(next, true);
  if (typeof player.play === "function" && player.paused) player.play();
  saveSettings();
  return next;
}

// Game-observed HCG progression. A step may have a one-shot intro followed by
// an automatically queued looping animation (for example Act_05 -> Act_06).
function playSceneStep(index) {
  const sequence = (currentAsset && currentAsset.sceneSequence) || [];
  // skeleton 判空与 applySkin / playAnimation 保持一致：加载窗口内可能还没有骨架
  if (!player || !player.skeleton || !player.skeleton.data || !sequence.length) return null;
  const normalized = ((index % sequence.length) + sequence.length) % sequence.length;
  const step = sequence[normalized];
  if (!step || !player.skeleton.data.findAnimation(step.animation)) return null;

  const generation = ++scenePlaybackGeneration;
  const expectedPlayer = player;
  const expectedAsset = currentAsset;
  const isCurrentStep = () => generation === scenePlaybackGeneration
    && player === expectedPlayer && currentAsset === expectedAsset;
  clearTimeout(sceneHoldTimer);
  sceneHoldTimer = null;
  clearTimeout(cgReturnTimer);
  cgReturnTimer = null;

  const state = player.animationState || player.state;
  if (state && typeof state.clearTracks === "function") state.clearTracks();
  __c.anim++;
  // 每个阶段可以自带表情（CG 的表情是静态皮肤，游戏没有表情动画时间轴）
  if (step.face || step.face2) {
    // 这里只改下拉值：皮肤统一由 setAnimation 之后的 applySkin 应用一次。
    // 原来多调一次 applySkin 会用"上一段"的动画名去算 sceneSkins，纯冗余。
    if (step.face) faceSelect.value = step.face;
    if (step.face2) face2Select.value = step.face2;
  }
  if (layoutController) layoutController.setAnimationName(step.animation);
  const entry = player.setAnimation(step.animation, step.loop !== false);
  animationSelect.value = step.animation;
  applySkin();

  // 自动连播：这一段播完就接下一段，播到最后一段为止。
  // 三种收尾方式：
  //   1) 纯一段动画（loop:false）→ 播完立刻下一段
  //   2) 配了 then（如 Act → Gacha 循环）→ 等 Act 播完 + thenHoldMs 的循环停留再走
  //   3) holdMs 强制停留（某段动画太短时按指定时长再走）
  if (entry && sceneAutoPlaying) {
    if (normalized < sequence.length - 1) {
      const advance = () => {
        if (!isCurrentStep() || !sceneAutoPlaying) return;
        playSceneStep(normalized + 1);
      };
      const anim = player.skeleton.data.findAnimation(step.animation);
      let delay = null;
      if (step.then) {
        // 只有显式写了 thenHoldMs 才参与自动推进；没写就停在 then 的循环里等点击，
        // 免得给老数据（10423 的 Act_05→Act_06 这类）意外加上自动跳段。
        if (Number(step.thenHoldMs) > 0) {
          delay = Math.round((anim ? anim.duration * 1000 : 0) + Number(step.thenHoldMs));
        }
      } else if (step.holdMs > 0) {
        delay = step.holdMs;
      }
      if (delay !== null) {
        clearTimeout(sceneHoldTimer);
        sceneHoldTimer = setTimeout(advance, delay);
      } else if (step.loop === false) {
        entry.listener = { complete: advance };
      }
    } else {
      // 最后一段播完，自动连播结束（停在最后一段，等点击重新从第一段开始）
      sceneAutoPlaying = false;
    }
  }

  if (step.then && player.skeleton.data.findAnimation(step.then)) {
    const isLastStep = normalized === sequence.length - 1;
    const queued = player.addAnimation(step.then, step.thenLoop !== false, 0);
    if (queued) {
      queued.listener = {
        start: () => {
          if (!isCurrentStep()) return;
          if (currentAsset && currentAsset.sceneSequence === sequence) {
            animationSelect.value = step.then;
            // then 段可能有自己的皮肤（Gacha 皮肤会替换交合相关槽），必须重套一次；
            // 顺带把布局缩放切到 then 的包络，避免 Gacha 摆幅更大被裁切。
            if (layoutController) layoutController.setAnimationName(step.then);
            applySkin();
          }
          // 最后一段的 then（如泉之助 Act_06 -> BG_fx_loop）：then 开始才起倒计时，
          // 这样"再停 thenHoldMs 就回培欲"和普通段"再停 thenHoldMs 就进下一段"是一套语义
          if (isLastStep && Number(step.thenHoldMs) > 0) {
            const secret = cgSecret();
            if (secret && currentAsset && currentAsset.id === secret.to) armCgReturn(Number(step.thenHoldMs));
          }
        }
      };
    }
  }

  sceneStepIndex = normalized;
  // 走到最后一个阶段说明这一轮播完了，等一会儿自动回到培欲造型（彩蛋路径）。
  // 期间继续点（回到前面的阶段）说明还想看，撤掉倒计时。
  // 最后一段若自带 then + thenHoldMs，倒计时交给上面 then 的 start 回调，别在这里提前起。
  const secret = cgSecret();
  const atLastStep = normalized === sequence.length - 1;
  const lastHandledByThen = atLastStep
    && step.then && Number(step.thenHoldMs) > 0
    && !!player.skeleton.data.findAnimation(step.then);
  if (secret && currentAsset && currentAsset.id === secret.to && atLastStep && !lastHandledByThen) {
    // 最后一段没有 then（结尾就是这一幕本身，如白威 10444 的 Act_06）：
    // 写了 holdMs 就是"这一幕播完再停 holdMs 才回退"，所以倒计时 = 动画时长 + holdMs；
    // 没写就沿用角色配置的 returnDelayMs（从本段开始算），保持老造型行为不变。
    if (Number(step.holdMs) > 0) {
      const anim = player.skeleton.data.findAnimation(step.animation);
      armCgReturn(Math.round((anim ? anim.duration * 1000 : 0) + Number(step.holdMs)));
    } else {
      armCgReturn();
    }
  } else if (!atLastStep) {
    clearTimeout(cgReturnTimer);
    cgReturnTimer = null;
  }
  if (typeof player.play === "function" && player.paused) player.play();
  saveSettings();
  return step.animation;
}

function loadAsset(asset) {
  markRenderActivity();
  // 防御：模型可能不属于当前模式（下拉值无效），此时直接忽略，
  // 否则 currentAsset 会变成 undefined，导致后续动画全部退化为 Idle。
  if (!asset) return;
  if (dialogueBubble) dialogueBubble.hide();
  clearTimeout(pixelHitVerifyTimer);
  pixelHitVerifyTimer = null;
  // Recover from a previous model's conservative whole-window fallback as
  // soon as a new load starts. Until its canvas appears, mouse movement will
  // correctly report transparent pixels rather than blocking the desktop.
  pixelHitEnabled = true;
  __lastPixelHit = null;
  // 静帧轮播是完全不同的一套渲染（DOM 图片，不是 WebGL 骨骼），单独走一条路
  if (isStillsAsset(asset)) {
    loadStills(asset);
    return;
  }
  cancelScenePlayback();
  const loadGeneration = ++assetLoadGeneration;
  const isCurrentLoad = () => loadGeneration === assetLoadGeneration && currentAsset === asset;
  const disposeOutdatedInstance = instance => {
    try {
      if (instance && typeof instance.dispose === "function") instance.dispose();
    } catch (error) {
      // A newer load may already have disposed the old instance.
    }
  };
  // 从静帧切回骨骼造型：收起图片层，否则它会一直盖在角色上面
  hideStills();
  const hintEl = document.getElementById("hint");
  if (hintEl) hintEl.textContent = "右键设置 · 拖动移动 · 单击触发动作";
  currentAsset = asset;
  buildRfyVariantUI();
  sceneStepIndex = 0;
  resetProgression();
  // 基础状态取自当前角色的配置（models[id].base），未配则用全局默认
  const base = baseFor(asset.id) || {};
  setOptions(faceSelect, asset.faces, base.face || DEFAULT.face || asset.defaultFace);
  if (asset.r18States) {
    setOptions(r18Select, asset.r18States, base.r18 || asset.defaultR18State);
  }
  setOptions(animationSelect, asset.animations, idleName());
  // 双人 CG 的第二张脸：只在模型带 faces2 时参与组合皮肤
  if (asset.faces2) {
    setOptions(face2Select, asset.faces2, asset.defaultFace2 || asset.faces2[0]);
  } else {
    face2Select.replaceChildren();
  }
  if (layoutController) {
    layoutController.dispose();
    layoutController = null;
  }
  stopFrameLimiter();
  if (player) player.dispose();
  applyDevMode();
  document.getElementById("player").replaceChildren();
  const config = {
    atlasUrl: "assets/" + asset.atlas,
    // 部分素材是 JSON 格式 skel；SpinePlayer 的 binaryUrl 只接受二进制，
    // 所以按 asset.binary 字段区分 jsonUrl / binaryUrl。
    ...(asset.binary === false
      ? { jsonUrl: "assets/" + asset.skeleton }
      : { binaryUrl: "assets/" + asset.skeleton }),
    showControls: false,
    alpha: true,
    backgroundColor: "#00000000",
    premultipliedAlpha: asset.pma,
    preserveDrawingBuffer: true,
    draw: instance => {
      if (dialogueBubble && player === instance) dialogueBubble.followHead();
      // 提示条跟着脚底走（内部节流，不额外开定时器）
      if (player === instance) positionHint(false);
    },
    // 注意：不能写死 "Idle"，没有 Idle 的模型会在这里抛错导致整个渲染不出来
    animation: idleName(),
    success: async instance => {
      if (!isCurrentLoad()) {
        disposeOutdatedInstance(instance);
        return;
      }
      player = instance;
      installFrameLimiter(instance);
      // Any Spine asset with a generated profile automatically uses the unified
      // controller. New assets need no renderer.js entry; a missing/invalid
      // profile safely falls back to the legacy path.
      const useUnifiedLayout = !!layoutProfiles[asset.id]
        && window.SpineLayout && window.SpineLayout.SpineLayoutController;
      // Assets without a valid profile keep the runtime's native viewport.
      // 伴生骨架注入（白威测试）：必须在 applySkin 之前完成，
      // 否则表情/Erect 皮肤还没合并进主骨架
      if (asset.companion) {
        let companionResult;
        try {
          companionResult = await injectCompanionSkeleton(instance, asset.companion);
        } catch (e) {
          companionResult = { error: String(e && e.message || e), stack: String(e && e.stack || "").split("\n").slice(0, 4) };
        }
        // The companion injection awaits file loading. The user may switch to
        // another costume while it is in flight, so validate the token again.
        if (!isCurrentLoad() || player !== instance) {
          disposeOutdatedInstance(instance);
          return;
        }
        __c.companion = companionResult;
      }
      applySkin();
      buildArmorUI();
      buildRfyVariantUI();
      // 白威测试：切到该造型即应用默认换装参数（9/12），并刷新一次面板/皮肤
      if (currentAsset.id === "bw_test") {
        applyBwTestDefaults();
        buildArmorUI();
        applySkin();
      }
      if (useUnifiedLayout) {
        // bw_test receives slots/bones from the companion skeleton. The merged
        // bw_armor profile is its conservative precomputed envelope; it shares
        // the same torso anchor and protects armor/tail motion without live jitter.
        const profile = asset.id === "bw_test"
          ? (layoutProfiles.bw_armor || layoutProfiles[asset.id])
          : layoutProfiles[asset.id];
        layoutController = new window.SpineLayout.SpineLayoutController(
          player, asset, profile, { animationName: animationSelect.value || idleName() }
        );
        layoutController.setAdjustment({
          zoom: displayZoom,
          offsetX: displayOffsetX,
          offsetY: displayOffsetY
        });
        // Each costume has its own precomputed motion envelope. Resize once
        // after switching assets so wide tails/armor gain transparent space
        // instead of forcing the character body to shrink.
        applyWindowSize();
      }
      // 注入改变了包围盒：在这里重算一次视口（装甲全挂、包围盒最全）。
      // 注意只能在"全挂"状态下重算 —— 任意部件被摘成 null 后重算会得到
      // 无效视口（人物整体消失且无报错），所以部件开关路径不做重算。
      if (currentAsset && currentAsset.companion && typeof player.setViewport === "function") {
        try { player.setViewport(animationSelect.value || idleName()); } catch (e) { /* 保持现状 */ }
      }
      // 带 autoAdvance 的 CG：进入后自动按 Act_01 -> ... -> 最后一段播一遍，
      // 每段用自己配的表情。播完后由点击逐段推进（从 Act_01 重新开始）。
      if (asset.autoAdvance && asset.sceneSequence && asset.sceneSequence.length) {
        sceneAutoPlaying = true;
        playSceneStep(0);
      } else {
        playAnimation(animationSelect.value || idleName(), true);
      }
      // Spine Player 创建后默认为 paused=true，只渲染第一帧、画面完全静止。
      // 必须显式调用 play() 才会驱动 animationState 逐帧推进。
      if (typeof player.play === "function") player.play();
      // Restore every developer control after loading, including the animation
      // row hidden by a previous still image. Layout controls need a controller.
      applyDevMode();
      // 首帧渲染完成后自检一次像素读取是否可用。
      // 每次载入都先重置回"支持"：之前某个造型失败过不能连累后面的造型。
      pixelHitEnabled = true;
      __lastPixelHit = null; // 强制下一次 mousemove 重新上报
      positionHint(true);
      schedulePixelHitVerification(isCurrentLoad, instance);
    }
  };
  player = new spine.SpinePlayer("player", config);
  saveSettings();
}

// ===== 设置面板可拖动 =====
// 面板是页面内的绝对定位元素，物理上离不开窗口；但窗口本身可能被拖到屏幕边缘，
// 或放大到超出屏幕（150% 时 840x1140 会超出 1080p 屏），所以可放置区域取
// 「窗口可视区 ∩ 当前显示器工作区（换成窗口内坐标）」，面板永远不会滑出屏幕。
// 关键点：记住的是「想放的位置」panelPref，每次显示都重新钳制。
// 这样窗口缩小把面板挤回来之后，窗口再放大面板能回到原位，而不是被永久挪走。
const PANEL_MARGIN = 6;
const PANEL_POS_KEY = "pet10423.panelPos.v1";
let panelPref = readPanelPref();
let panelDrag = null;
const panelTitle = panel.querySelector(".panel-title");

function readPanelPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || "null");
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return { x: raw.x, y: raw.y };
  } catch (error) {
    // 存档损坏就当没存过，回到默认右上角
  }
  return { x: null, y: null };
}

function savePanelPref() {
  try {
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPref));
  } catch (error) {
    // localStorage 不可用时忽略：位置只在本次运行内有效
  }
}

// 窗口内可放置区域的边界（单位：窗口内 CSS 像素）
function panelSafeArea() {
  const scr = window.screen || {};
  const sx = window.screenX || 0;
  const sy = window.screenY || 0;
  const availLeft = Number.isFinite(scr.availLeft) ? scr.availLeft : 0;
  const availTop = Number.isFinite(scr.availTop) ? scr.availTop : 0;
  const availW = scr.availWidth || window.innerWidth;
  const availH = scr.availHeight || window.innerHeight;
  return {
    left: Math.max(0, availLeft - sx),
    top: Math.max(0, availTop - sy),
    right: Math.min(window.innerWidth, availLeft + availW - sx),
    bottom: Math.min(window.innerHeight, availTop + availH - sy)
  };
}

// 把目标位置压进可放置区域；面板比可用区还大时靠左上角贴边，至少标题栏可见
// ===== 面板避让角色 =====
// 窗口右侧已经按 layout.panelReserveAspect 留了一条空带（见 spine-layout.js），
// 这里再兜一层：面板拖动时如果和人物包围盒相交，就往右边（放不下再往左）推出去。
// 两边都放不下时保持原样，不强行夹取，免得小窗口下面板变得没法用。
// 角色待机时呼吸/尾巴摆动会让包围盒左右浮动十几像素，间隙要比它大
const PANEL_GAP = 24;

// 每次现算（拖动时才调用，约 1~2ms）：角色在呼吸/动作时包围盒会变，
// 用缓存会出现"面板刚好压住几像素"的情况。
function characterScreenBox() {
  const skeleton = player && player.skeleton;
  const viewport = player && (player.currentViewport || player.viewport);
  const canvas = player && player.canvas;
  if (!skeleton || !viewport || !canvas || !viewport.width || !viewport.height) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  // 顺便记每个槽的包围盒：最后用"贴底那一圈"估脚的位置（见下方 footX）
  const slotBoxes = [];
  for (const slot of skeleton.slots) {
    const attachment = slot.getAttachment ? slot.getAttachment() : slot.attachment;
    if (!attachment || slot.color.a <= 0) continue;
    const count = attachment.worldVerticesLength;
    if (!count) continue;
    const vertices = new Float32Array(count);
    try { attachment.computeWorldVertices(slot, 0, count, vertices, 0, 2); } catch (error) { continue; }
    let slotLeft = Infinity, slotRight = -Infinity, slotBottom = -Infinity;
    for (let i = 0; i < count; i += 2) {
      const sx = rect.left + (vertices[i] - viewport.x) / viewport.width * rect.width;
      const sy = rect.top + (1 - (vertices[i + 1] - viewport.y) / viewport.height) * rect.height;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      left = Math.min(left, sx); right = Math.max(right, sx);
      top = Math.min(top, sy); bottom = Math.max(bottom, sy);
      if (sx < slotLeft) slotLeft = sx;
      if (sx > slotRight) slotRight = sx;
      if (sy > slotBottom) slotBottom = sy;
    }
    if (Number.isFinite(slotLeft) && slotRight > slotLeft) {
      slotBoxes.push({ left: slotLeft, right: slotRight, bottom: slotBottom });
    }
  }
  if (!Number.isFinite(left) || right <= left) return null;
  // 脚部横向中心：取"离画面底边最近的那 8% 高度"里所有槽的水平中点平均值。
  // 比整只角色的包围盒中心更贴脚（尾巴/披风往一边甩时不会把提示条带偏）。
  let footX = (left + right) / 2;
  const band = Math.max(8, (bottom - top) * 0.08);
  let sum = 0, hits = 0;
  for (const box of slotBoxes) {
    if (box.bottom >= bottom - band) { sum += (box.left + box.right) / 2; hits++; }
  }
  if (hits) footX = sum / hits;
  return { left, right, top, bottom, footX };
}

// ===== 底部操作提示：贴住角色脚底 =====
// 原来固定在窗口底部中间；但窗口比人物宽（右侧还要给面板留空带），
// 提示条和人物是两套对齐基准，看着像"飘在下面"。改成按角色包围盒的脚底中心定位。
// 待机时呼吸会让脚底轻微上下动，所以在每帧的 draw 回调里跟进（内部节流到 ~7Hz）。
const HINT_ANCHOR_INTERVAL_MS = 140;
let hintAnchorAt = 0;

function positionHint(force) {
  const hintEl = document.getElementById("hint");
  if (!hintEl) return;
  if (!force && (document.hidden || performance.now() - hintAnchorAt < HINT_ANCHOR_INTERVAL_MS)) return;
  // CSS only exposes #hint while body:hover. Avoid walking and allocating
  // world vertices ~7 times/sec for a hint nobody can see. Model/resize calls
  // still force an update; hovering resumes normal tracking next frame.
  if (!force && document.body && typeof document.body.matches === "function"
    && !document.body.matches(":hover")) return;
  hintAnchorAt = performance.now();
  const box = characterScreenBox();
  if (!box) {
    // 场景 / 静帧这类没有骨架的画面：回到窗口底部居中，避免留在旧位置
    hintEl.classList.remove("anchored");
    hintEl.style.left = "";
    hintEl.style.top = "";
    return;
  }
  hintEl.classList.add("anchored");
  const width = hintEl.offsetWidth || 0;
  const height = hintEl.offsetHeight || 0;
  const half = width / 2;
  const margin = 6;
  // 对齐"脚部"而不是整只角色：characterScreenBox() 已经给出了贴底那一圈的横向中心
  const centerX = Number.isFinite(box.footX) ? box.footX : (box.left + box.right) / 2;
  const safeCenter = Math.min(
    Math.max(centerX, half + margin),
    Math.max(half + margin, window.innerWidth - half - margin)
  );
  // 贴在脚底下方 6px；底部实在放不下就压到窗口底边（宁可轻微压脚，也不跑出窗口）
  const top = Math.min(box.bottom + 6, Math.max(0, window.innerHeight - height - 4));
  hintEl.style.left = Math.round(safeCenter) + "px";
  hintEl.style.top = Math.round(top) + "px";
}

function pushPanelOffCharacter(pos) {
  const box = characterScreenBox();
  if (!box) return pos;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const hits = pos.x < box.right + PANEL_GAP && pos.x + w > box.left - PANEL_GAP
    && pos.y < box.bottom + PANEL_GAP && pos.y + h > box.top - PANEL_GAP;
  if (!hits) return pos;
  const area = panelSafeArea();
  const rightX = Math.round(box.right + PANEL_GAP);
  if (rightX + w <= area.right - PANEL_MARGIN) return { x: rightX, y: pos.y };
  const leftX = Math.round(box.left - PANEL_GAP - w);
  if (leftX >= area.left + PANEL_MARGIN) return { x: leftX, y: pos.y };
  return pos;
}

function clampPanel(x, y) {
  const area = panelSafeArea();
  const minX = area.left + PANEL_MARGIN;
  const minY = area.top + PANEL_MARGIN;
  const maxX = area.right - PANEL_MARGIN - panel.offsetWidth;
  const maxY = area.bottom - PANEL_MARGIN - panel.offsetHeight;
  const pos = {
    x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY)))
  };
  return pushPanelOffCharacter(pos);
}

function renderPanelPos() {
  if (panel.classList.contains("hidden")) return;
  if (panelPref.x === null) {
    // 第一次显示：默认贴右上角（沿用原来的观感）
    panelPref = { x: window.innerWidth - 12 - panel.offsetWidth, y: 12 };
  }
  const pos = clampPanel(panelPref.x, panelPref.y);
  panel.style.left = pos.x + "px";
  panel.style.top = pos.y + "px";
  panel.style.right = "auto";
}

// 面板比「窗口∩屏幕」的可用区还大时，怎么摆都会被裁。
// 典型场景：角色缩到 50%（窗口 280x380）又拖到屏幕右下角，可用区只剩 140x132，
// 而面板本身 264x261 —— 之前就是这样连标题栏和关闭按钮都露不出来。
// 处理：临时把窗口挪进屏幕，关面板时再挪回原处（角色位置不被打扰）。
let panelNudgeOrigin = null;

function nudgeWindowIntoScreen() {
  const area = panelSafeArea();
  const needW = panel.offsetWidth + PANEL_MARGIN * 2;
  const needH = panel.offsetHeight + PANEL_MARGIN * 2;
  if (area.right - area.left >= needW && area.bottom - area.top >= needH) return false;
  const scr = window.screen || {};
  const availLeft = Number.isFinite(scr.availLeft) ? scr.availLeft : 0;
  const availTop = Number.isFinite(scr.availTop) ? scr.availTop : 0;
  const availW = scr.availWidth || window.innerWidth;
  const availH = scr.availHeight || window.innerHeight;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  // 窗口装得下就整体移进屏幕；窗口比屏幕还高（150% 时 1140 > 1080）就只在超出方向居中
  const targetX = winW <= availW
    ? Math.min(Math.max(window.screenX, availLeft), availLeft + availW - winW)
    : availLeft + Math.round((availW - winW) / 2);
  const targetY = winH <= availH
    ? Math.min(Math.max(window.screenY, availTop), availTop + availH - winH)
    : availTop + Math.round((availH - winH) / 2);
  // 只记住第一次的原始位置：窗口变大时可能被挪第二次，关闭面板要能回到最初的地方
  if (!panelNudgeOrigin) panelNudgeOrigin = { x: window.screenX, y: window.screenY };
  window.petAPI.moveWindow(targetX, targetY);
  return true;
}

// ===== AI 状态展示（面板上的那一行）=====
// 只显示"能不能用 + 为什么不能用"，不显示 Key 本身（主进程只给 4+4 的掩码）。
function renderAiStatus() {
  if (!aiStatusText) return;
  if (!aiStatus) {
    aiStatusText.textContent = "读取中…";
    aiStatusText.className = "pending";
    return;
  }
  const available = !!aiStatus.available;
  if (aiEnabledCheckbox) {
    aiEnabledCheckbox.checked = !!aiStatus.enabled;
    // --no-ai 启动时锁住开关，避免用户以为点了就能用
    aiEnabledCheckbox.disabled = aiStatus.reason === "disabled-by-flag";
  }
  // 配置区只在勾选「AI 对话」后展开；没勾选时面板保持干净（默认状态）
  if (aiBox) aiBox.classList.toggle("hidden", !aiStatus.enabled);
  // Key 永远不回显，只显示 4+4 掩码；输入框留空 = 不修改已保存的 Key
  if (aiKeyState) aiKeyState.textContent = aiStatus.keyHint ? "已保存 " + aiStatus.keyHint : "未保存";
  if (aiKeyInput) {
    aiKeyInput.placeholder = aiStatus.keyHint ? "已保存，留空则不修改" : "sk-…（只保存在本机）";
  }
  if (aiModelInput && document.activeElement !== aiModelInput) {
    aiModelInput.value = aiStatus.model || "";
  }
  let text = "";
  let tone = "";
  if (aiStatus.reason === "disabled-by-flag") {
    text = "本次启动已禁用 AI · 用本地台词";
  } else if (aiStatus.reason === "no-api-key") {
    text = aiStatus.enabled ? "未配置 Key · 用本地台词" : "未开启 · 用本地台词";
    tone = "pending";
  } else if (aiStatus.reason === "disabled") {
    text = "未开启 · 用本地台词";
  } else if (aiStatus.cooldownRemainingMs > 0) {
    text = "请求失败冷却中 · 用本地台词";
    tone = "error";
  } else if (!available) {
    text = "不可用 · 用本地台词";
    tone = "error";
  } else {
    text = (aiStatus.provider || "DeepSeek") + " · " + aiStatus.model;
  }
  aiStatusText.textContent = text;
  aiStatusText.className = tone;
  if (aiHint) {
    const hints = [];
    if (aiStatus.enabled && !aiStatus.keyHint) {
      hints.push("填好 API Key 并点「保存」，再点「测试连接」确认可用。");
    }
    if (aiStatus.lastErrorText) hints.push("上次：" + aiStatus.lastErrorText);
    aiHint.textContent = hints.join("　");
    aiHint.classList.toggle("hidden", hints.length === 0);
  }
}

function showAiHint(text) {
  if (!aiHint) return;
  aiHint.textContent = text || "";
  aiHint.classList.toggle("hidden", !text);
}

async function refreshAiStatus() {
  if (!window.petAPI || typeof window.petAPI.getAiStatus !== "function") {
    // 旧版 preload 没有这个桥：面板显示不可用即可，不要让界面永远停在"读取中"
    aiStatus = { available: false, enabled: false, reason: "unavailable" };
    renderAiStatus();
    return null;
  }
  try {
    aiStatus = await window.petAPI.getAiStatus();
  } catch (error) {
    aiStatus = null;
  }
  renderAiStatus();
  syncIdleInterval();
  return aiStatus;
}

function openPanel() {
  markRenderActivity();
  if (dialogueBubble) dialogueBubble.hide();
  panel.classList.remove("hidden");
  // 面板打开时重新问一次状态：用户可能刚在配置文件里换了 Key，不必重启
  refreshAiStatus();
  // 面板一打开就让窗口保持可捕获：否则鼠标还没移动时处于穿透态，点不到面板
  __lastPixelHit = true;
  window.petAPI.setMouseHit(true);
  renderPanelPos();
  if (!nudgeWindowIntoScreen()) return;
  // 窗口移动是异步的（IPC → 主进程 setPosition），screenX 要过一会儿才更新，
  // 这里重排几次，位置稳定后面板自然落在完整可见处
  let tries = 0;
  const tick = () => {
    if (panel.classList.contains("hidden")) return;
    renderPanelPos();
    if (++tries < 12) setTimeout(tick, 100);
  };
  setTimeout(tick, 120);
}

function closePanel() {
  markRenderActivity();
  panel.classList.add("hidden");
  __lastPixelHit = null; // 下一帧移动重新按角色像素判定是否可点
  if (!panelNudgeOrigin) return;
  const origin = panelNudgeOrigin;
  panelNudgeOrigin = null;
  window.petAPI.moveWindow(origin.x, origin.y);
}

function endPanelDrag(event) {
  if (!panelDrag) return;
  if (event && event.pointerId !== undefined && event.pointerId !== panelDrag.id) return;
  try {
    panelTitle.releasePointerCapture(panelDrag.id);
  } catch (error) {
    // 没真正捕获过（自动化脚本合成的事件）会抛，忽略
  }
  panelDrag = null;
  panel.classList.remove("dragging");
  savePanelPref();
}

panelTitle.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  // 关闭按钮等交互控件不触发拖动
  if (event.target.closest("button, select, input, a, output")) return;
  const rect = panel.getBoundingClientRect();
  panelDrag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  panel.classList.add("dragging");
  try {
    panelTitle.setPointerCapture(event.pointerId);
  } catch (error) {
    // 同上，合成事件时没有真实指针可捕获
  }
  event.preventDefault();
});

// 监听挂在 window 上：鼠标拉出标题栏（甚至拉出面板）时面板仍然跟着走
window.addEventListener("pointermove", event => {
  if (!panelDrag || event.pointerId !== panelDrag.id) return;
  panelPref = { x: event.clientX - panelDrag.dx, y: event.clientY - panelDrag.dy };
  renderPanelPos();
});
window.addEventListener("pointerup", endPanelDrag);
window.addEventListener("pointercancel", endPanelDrag);

window.addEventListener("resize", () => {
  if (dialogueBubble) dialogueBubble.reposition();
  renderPanelPos();
  positionHint(true);
  if (layoutController) {
    // Electron resizes the transparent WebGL surface asynchronously. The
    // controller only needs to reapply its precomputed viewport after the
    // canvas adopts the final size. Do not call SpinePlayer.setViewport()
    // without an animation: this runtime clears currentViewport before it
    // discovers that the animation argument is missing.
    setTimeout(() => {
      if (layoutController && player) layoutController.apply("window-resize");
      // 视口重排后脚底位置会变，等下一帧再贴一次
      positionHint(true);
    }, 80);
  }
  // 窗口变大后右下角可能又顶出屏幕，可用区不够就再把窗口挪回来
  if (!panel.classList.contains("hidden")) nudgeWindowIntoScreen();
});

stage.addEventListener("contextmenu", event => {
  event.preventDefault();
  if (panel.classList.contains("hidden")) openPanel();
  else closePanel();
});
document.getElementById("hidePanel").onclick = closePanel;
document.getElementById("creditLink").addEventListener("click", event => {
  event.preventDefault();
  if (window.petAPI && window.petAPI.openExternal) {
    window.petAPI.openExternal("https://space.bilibili.com/3418701");
  }
});

stage.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !panel.classList.contains("hidden")) return;
  // 边缘透明区不可拖动：落在半透明描边/阴影上就不算抓住角色
  // （鼠标移动有 33ms 节流，按下这一刻必须再确认一次，不能只信上一次 mousemove 的结果）
  if (pixelHitEnabled && !isOpaqueAt(event.clientX, event.clientY)) return;
  if (dialogueBubble) dialogueBubble.hide();
  downRegion = (!isStillsAsset() && !isSceneAsset())
    ? detectRegion(event.clientX, event.clientY)
    : null;
  downDialogueArea = (!isStillsAsset() && !isSceneAsset())
    ? detectClickedDialogueArea(event.clientX, event.clientY, downRegion) : null;
  stage.setPointerCapture(event.pointerId);
  downPoint = { x: event.screenX, y: event.screenY, time: Date.now() };
  dragging = true;
  stage.classList.add("dragging");
  window.petAPI.startDrag();
});
stage.addEventListener("pointerup", event => {
  if (!dragging) return;
  dragging = false;
  stage.classList.remove("dragging");
  window.petAPI.stopDrag();
  __c.pointerup++;
  const distance = Math.hypot(event.screenX - downPoint.x, event.screenY - downPoint.y);
  // 单击：按点击部位播放对应动画（头=Hit_face / 躯干=Hit / 下半身=Hit_all）
  if (distance < 7 && Date.now() - downPoint.time < 350) {
    __c.reaction++;
    // HCG 这类场景模型没有 Idle/Hit，点击切成"播下一个 Act"；
    // 角色造型维持原来的"按部位播反应动画 + 累积触发表情"；
    // 静帧轮播没有骨架，点击就是"切下一张"
    if (isStillsAsset()) {
      advanceStills();
    } else if (isSceneAsset()) {
      cycleAct();
    } else {
      const clickedAsset = currentAsset;
      const clickedCharacter = currentCharacter();
      const region = playReactionAt(event.clientX, event.clientY, downRegion);
      handleClickProgression(region);
      // A progression rule may enter a CG and replace the asset. The new scene
      // clears the old bubble, so do not immediately restore it after the jump.
      if (dialogueBubble && clickedCharacter && currentAsset === clickedAsset) {
        // AI 可用时：气泡先占位，AI 回来替换；不可用/失败则用本地原台词（选池规则不变）
        speakClickLine(clickedCharacter, downDialogueArea, nextClickStreak(downDialogueArea));
      }
    }
  }
  downRegion = null;
  downDialogueArea = null;
});
stage.addEventListener("pointercancel", () => {
  markRenderActivity();
  dragging = false;
  downRegion = null;
  downDialogueArea = null;
  stage.classList.remove("dragging");
  window.petAPI.stopDrag();
});
stage.addEventListener("lostpointercapture", () => {
  if (!dragging) return;
  dragging = false;
  downRegion = null;
  downDialogueArea = null;
  stage.classList.remove("dragging");
  window.petAPI.stopDrag();
});
window.addEventListener("blur", () => {
  if (!dragging) return;
  dragging = false;
  downRegion = null;
  downDialogueArea = null;
  stage.classList.remove("dragging");
  window.petAPI.stopDrag();
});
document.addEventListener("visibilitychange", () => {
  if (idleDialogue) {
    if (document.hidden) idleDialogue.stop();
    else idleDialogue.reset();
  }
  if (document.hidden && dialogueBubble) dialogueBubble.hide();
  if (!document.hidden || !dragging) return;
  dragging = false;
  downRegion = null;
  downDialogueArea = null;
  stage.classList.remove("dragging");
  window.petAPI.stopDrag();
});

// ===== 像素级点击命中：透明区域不再拦截桌面点击 =====
// 桌宠窗口是整块透明矩形、角色只占其中约 30%，所以默认让窗口处于"忽略鼠标、
// 但转发移动事件"的状态；页面持续检查光标是否落在角色的不透明像素上，
// 命中才通知主进程恢复捕获。SpinePlayer 已开启 preserveDrawingBuffer，
// 可以用离屏 2D canvas 从 WebGL canvas 直接拷像素。
// 命中判定（对所有角色生效，包括以后新增的角色）
// alpha 阈值取得高、采样半径取得小，是为了让角色"边缘的透明区域"不可交互：
// 抗锯齿的半透明描边、柔和阴影/光晕这类 alpha 很低的像素不算人物实体，
// 光标落在上面时窗口直接放行给桌面，既拖不动也点不到。
const HIT_ALPHA = 128;  // alpha 低于此值视为透明（不是人物实体）
const HIT_RADIUS = 1;   // 采样半径（canvas 像素）：只取光标所在像素及其四邻
// 仅用于启动自检的宽松阈值：确认 preserveDrawingBuffer 真的能读到像素，
// 避免自检失败导致整个"透明区不拦截"功能被误关掉
// （自检已改为整画布降采样扫描，不再需要采样半径）
const PROBE_ALPHA = 12;
let pixelHitEnabled = true;
let __probeCanvas = null;
let __probeCtx = null;
let __verifyCanvas = null;
let __verifyCtx = null;
let __lastPixelHit = null;
let __lastMoveAt = 0;
let pixelHitVerifyTimer = null;

function isOpaqueAt(clientX, clientY, alpha = HIT_ALPHA, radius = HIT_RADIUS) {
  // 静帧轮播：图是矩形全不透明（alpha 实测全 255），直接按真实画面矩形判定，
  // 不用读像素。矩形外仍是透明区，照样放行给桌面。
  if (isStillsAsset()) {
    const rect = stillsContentRect();
    if (!rect) return false;
    return clientX >= rect.left && clientX <= rect.left + rect.width &&
           clientY >= rect.top && clientY <= rect.top + rect.height;
  }
  const canvas = document.querySelector("#player canvas");
  if (!canvas || !canvas.width || !canvas.height) return false;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const px = Math.round((clientX - rect.left) * (canvas.width / rect.width));
  const py = Math.round((clientY - rect.top) * (canvas.height / rect.height));
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  const x0 = Math.max(0, px - radius);
  const y0 = Math.max(0, py - radius);
  const w = Math.max(1, Math.min(canvas.width, px + radius + 1) - x0);
  const h = Math.max(1, Math.min(canvas.height, py + radius + 1) - y0);
  try {
    if (!__probeCanvas) __probeCanvas = document.createElement("canvas");
    if (__probeCanvas.width < w) __probeCanvas.width = w;
    if (__probeCanvas.height < h) __probeCanvas.height = h;
    if (!__probeCtx) __probeCtx = __probeCanvas.getContext("2d", { willReadFrequently: true });
    __probeCtx.clearRect(0, 0, w, h);
    // 只拷光标附近这一小块，避免整帧 getImageData 的开销
    __probeCtx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    const data = __probeCtx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] >= alpha) return true;
    }
  } catch (error) {
    // 取不到像素时不能让桌宠变成完全不可点击 —— 明确回退到"整窗可点"
    failPixelHit("读取像素异常：" + (error && error.message ? error.message : error));
    return true;
  }
  return false;
}

// 像素检测不可用时的明确回退：整窗可点击（不再有透明区穿透）。
// 光置 pixelHitEnabled=false 不够 —— 主进程一直守着上次上报的 pixelHit 值，
// 必须主动上报一次 true，否则窗口可能永久穿透（点不到角色、开不了面板）或永久拦截桌面。
function failPixelHit(reason) {
  pixelHitEnabled = false;
  __lastPixelHit = true; // 同步本地状态，避免之后 updatePixelHit 里重复上报
  window.petAPI.setMouseHit(true);
  console.warn("[pet] 像素检测不可用，已回退到整窗可点击：" + reason);
}

// 一次性自检：缩小扫描整张画布，确认至少存在一个不透明角色像素。
// 不依赖骨骼名称和画布中心，因此兼容大小写混用、偏心角色及 HCG 场景。
// 慢机器会短暂重试；确实读不到时才明确回退到整窗可点。
function verifyPixelHitSupport(expectedPlayer = player) {
  if (!expectedPlayer || expectedPlayer !== player) {
    return { supported: null, reason: "模型已经切换" };
  }
  const canvas = document.querySelector("#player canvas");
  if (!canvas || !canvas.width || !canvas.height) {
    return { supported: null, reason: "画布尚未准备好" };
  }
  // Down-sample the whole rendered canvas instead of assuming particular bone
  // names or that the geometric centre is opaque. This works for mixed-case
  // rigs, HCG scenes and future characters with non-standard skeleton names.
  try {
    if (!__verifyCanvas) {
      __verifyCanvas = document.createElement("canvas");
      __verifyCtx = __verifyCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!__verifyCtx) return { supported: false, reason: "无法创建像素自检画布" };
    const sampleSize = 96;
    if (__verifyCanvas.width !== sampleSize || __verifyCanvas.height !== sampleSize) {
      __verifyCanvas.width = sampleSize;
      __verifyCanvas.height = sampleSize;
    }
    __verifyCtx.clearRect(0, 0, sampleSize, sampleSize);
    __verifyCtx.drawImage(canvas, 0, 0, sampleSize, sampleSize);
    const data = __verifyCtx.getImageData(0, 0, sampleSize, sampleSize).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] >= PROBE_ALPHA) return { supported: true, reason: null };
    }
    return { supported: null, reason: "画布暂时没有可见像素" };
  } catch (error) {
    return {
      supported: false,
      reason: "读取像素异常：" + (error && error.message ? error.message : error)
    };
  }
}

function schedulePixelHitVerification(isCurrentLoad, expectedPlayer, attempt = 0) {
  clearTimeout(pixelHitVerifyTimer);
  pixelHitVerifyTimer = setTimeout(() => {
    pixelHitVerifyTimer = null;
    if (!isCurrentLoad() || player !== expectedPlayer) return;
    const result = verifyPixelHitSupport(expectedPlayer);
    if (result.supported === true) return;
    // Slow machines may not have rendered a visible first frame at 600 ms.
    // Retry without ever allowing an old model's timer to affect a new model.
    if (result.supported === null && attempt < 5) {
      schedulePixelHitVerification(isCurrentLoad, expectedPlayer, attempt + 1);
      return;
    }
    failPixelHit(result.reason || "像素自检失败");
  }, attempt === 0 ? 600 : 200);
}

function updatePixelHit(clientX, clientY) {
  const panelOpen = !panel.classList.contains("hidden");
  // 拖动中 / 设置面板打开 / 空角色引导卡显示时必须保持可点击，否则会丢后续事件
  const on = emptyStateVisible || !pixelHitEnabled || dragging || panelOpen || isOpaqueAt(clientX, clientY);
  if (on !== __lastPixelHit) {
    __lastPixelHit = on;
    window.petAPI.setMouseHit(on);
  }
}

window.addEventListener("mousemove", event => {
  if (clickThrough || !pixelHitEnabled) return;
  const now = Date.now();
  if (now - __lastMoveAt < 33) return; // 节流到约 30fps
  __lastMoveAt = now;
  updatePixelHit(event.clientX, event.clientY);
});
window.addEventListener("mouseleave", () => {
  if (clickThrough || !pixelHitEnabled) return;
  __lastPixelHit = false;
  window.petAPI.setMouseHit(false);
});

// 实际操作会恢复 30 FPS；单纯悬停不会让多个桌宠一直保持高帧率。
window.addEventListener("pointerdown", markRenderActivity, true);
window.addEventListener("pointerup", markRenderActivity, true);
document.addEventListener("input", markRenderActivity, true);
document.addEventListener("change", markRenderActivity, true);

// 切换角色：造型清单整个换掉（applyCharacter 内部会保存选择）
characterSelect.onchange = () => applyCharacter(characterSelect.value);
// 切换模式：重建模型列表，并保持/回退到合适的模型
modeSelect.onchange = () => {
  applyMode(modeSelect.value);
  saveSettings();
};
// 切换模型：仅在当前模式允许的列表内
modelSelect.onchange = () => loadAsset(resolveMenuAsset(modelSelect.value));
devModeCheckbox.onchange = () => {
  applyDevMode();
  // 重建造型下拉：CG 场景标了 devOnly，会随开发者模式一起出现/消失。
  // 关掉开发者模式时若正停在 CG 上，applyMode 会自动回退到列表里的造型。
  applyMode(modeSelect.value);
  saveSettings();
};
// 窗口宽度由角色的预计算安全范围决定，多出的区域保持透明。
function applyWindowSize() {
  if (!window.petAPI) return;
  const scale = committedScale || 1;
  let baseWidth = BASE_WIDTH;
  if (currentAsset && layoutProfiles[currentAsset.id] && window.SpineLayout) {
    const profile = currentAsset.id === "bw_test"
      ? (layoutProfiles.bw_armor || layoutProfiles[currentAsset.id])
      : layoutProfiles[currentAsset.id];
    if (profile && profile.mode === "character" && typeof window.SpineLayout.requiredCanvasAspect === "function") {
      const aspect = window.SpineLayout.requiredCanvasAspect(
        profile,
        animationSelect.value || idleName(),
        { zoom: displayZoom, offsetX: displayOffsetX, offsetY: displayOffsetY }
      );
      baseWidth = Math.max(baseWidth, Math.ceil(BASE_HEIGHT * aspect));
    }
  }
  const w = Math.round(baseWidth * scale);
  window.petAPI.resizeWindow(w, Math.round(BASE_HEIGHT * scale));
  if (layoutController) {
    // Keep the valid current viewport while the native window is resizing.
    // Recompute once using the new canvas aspect ratio; no per-frame jumping.
    const controller = layoutController;
    setTimeout(() => {
      if (layoutController === controller) controller.apply("window-size");
    }, 120);
  } else if (player && typeof player.setViewport === "function") {
    // Legacy rollback path: this Spine runtime requires an animation argument.
    const animation = animationSelect.value || idleName();
    try { player.setViewport(animation); } catch (e) { /* 保持现状 */ }
  }
}
// 显示范围微调：拖动即时生效，松手才写 localStorage
dispZoomSlider.oninput = () => {
  displayZoom = Number(dispZoomSlider.value) / 100;
  dispZoomValue.value = dispZoomSlider.value + "%";
  applyDisplayAdjust();
};
dispZoomSlider.onchange = () => {
  // Manual display zoom can require more transparent width. Commit that
  // width only when the slider is released to avoid resize flicker.
  applyWindowSize();
  saveSettings();
};
dispXSlider.oninput = () => {
  displayOffsetX = Number(dispXSlider.value) / 100;
  dispXValue.value = dispXSlider.value + "%";
  applyDisplayAdjust();
};
dispXSlider.onchange = saveSettings;
dispYSlider.oninput = () => {
  displayOffsetY = Number(dispYSlider.value) / 100;
  dispYValue.value = dispYSlider.value + "%";
  applyDisplayAdjust();
};
dispYSlider.onchange = saveSettings;
dispResetButton.onclick = () => {
  displayZoom = 1;
  displayOffsetX = 0;
  displayOffsetY = 0;
  dispZoomSlider.value = "100";
  dispZoomValue.value = "100%";
  dispXSlider.value = "0";
  dispXValue.value = "0%";
  dispYSlider.value = "0";
  dispYValue.value = "0%";
  applyDisplayAdjust();
  applyWindowSize();
  saveSettings();
};
// 手动改表情 / R18 / 第二张脸 = 用户接管当前状态：清掉连点累积和"回退基础状态"定时器，
// 否则几秒后自动规则会把用户刚选的表情、R18 一起打回基础状态。
faceSelect.onchange = () => {
  resetProgression();
  applySkin();
};
r18Select.onchange = () => {
  resetProgression();
  applySkin();
};
face2Select.onchange = () => {
  resetProgression();
  applySkin();
};
armorAllOnButton.onclick = () => setAllArmor(true);
armorAllOffButton.onclick = () => setAllArmor(false);
animationSelect.onchange = () => {
  // 手动切动画也算接管，取消表情回退定时器
  resetProgression();
  cancelScenePlayback();
  const sequence = (currentAsset && currentAsset.sceneSequence) || [];
  const selectedStep = sequence.findIndex(step => step.animation === animationSelect.value);
  if (selectedStep >= 0) sceneStepIndex = selectedStep;
  const state = player && player.animationState;
  if (state && typeof state.clearTracks === "function") state.clearTracks();
  playAnimation(animationSelect.value, animationSelect.value === idleName());
};
alwaysOnTopCheckbox.onchange = event => window.petAPI.setAlwaysOnTop(event.target.checked);

// ===== 硬件加速（普通设置项，重启后生效） =====
let hardwareAccelerationAtStartup = false;
let hardwareAccelerationSaved = false;
let hardwareAccelerationForcedOff = false;
// 主进程传来的 performance-settings.json 真实路径，用于提示"起不来时删哪个文件"
let hardwareAccelerationSettingsPath = "";

function renderHardwareAccelerationStatus(error, failureText = "保存失败") {
  hardwareAccelerationStatus.classList.toggle("error", !!error);
  const pending = !error && hardwareAccelerationSaved !== hardwareAccelerationAtStartup;
  hardwareAccelerationStatus.classList.toggle("pending", pending);
  // 读写两条路径共用这个函数，失败文案必须区分开：
  // 启动时读取失败不该显示"保存失败"（用户根本没做过保存动作）
  if (error) hardwareAccelerationStatus.textContent = failureText;
  else if (hardwareAccelerationForcedOff) hardwareAccelerationStatus.textContent = "本次以兼容模式启动";
  else if (pending) hardwareAccelerationStatus.textContent = "重启桌宠后生效";
  else hardwareAccelerationStatus.textContent = hardwareAccelerationSaved
    ? "已开启"
    : "已关闭（兼容模式）";
  renderHardwareAccelerationHint();
}

// 这个开关一旦打开，如果下次启动因 GPU 崩溃而起不来，用户就再也打不开面板关掉它
//（本机 Electron 44 的已知故障模式）。所以只要"已开启且要等重启生效"，
// 就把恢复办法直接写在面板里，而不是只藏在 title 悬浮提示里。
function renderHardwareAccelerationHint() {
  if (!hardwareAccelerationHint) return;
  const show = hardwareAccelerationSaved === true && hardwareAccelerationAtStartup !== true;
  hardwareAccelerationHint.classList.toggle("hidden", !show);
  if (!show) return;
  const target = hardwareAccelerationSettingsPath || "performance-settings.json（Electron userData 目录下）";
  const code = document.createElement("code");
  code.textContent = target;
  hardwareAccelerationHint.replaceChildren(
    document.createTextNode("开启后若桌宠无法启动：删除 "),
    code,
    document.createTextNode(" 再重新打开即可恢复。")
  );
}

async function initHardwareAccelerationSetting() {
  try {
    const settings = await window.petAPI.getPerformanceSettings();
    hardwareAccelerationSaved = !!(settings && settings.hardwareAcceleration === true);
    hardwareAccelerationAtStartup = settings && typeof settings.activeHardwareAcceleration === "boolean"
      ? settings.activeHardwareAcceleration : hardwareAccelerationSaved;
    hardwareAccelerationForcedOff = !!(settings && settings.hardwareAccelerationForcedOff);
    hardwareAccelerationSettingsPath = settings && typeof settings.settingsPath === "string"
      ? settings.settingsPath
      : "";
    hardwareAccelerationCheckbox.checked = hardwareAccelerationSaved;
    renderHardwareAccelerationStatus();
  } catch (error) {
    hardwareAccelerationCheckbox.disabled = true;
    renderHardwareAccelerationStatus(error, "读取设置失败");
  }
}

hardwareAccelerationCheckbox.onchange = async () => {
  const wanted = hardwareAccelerationCheckbox.checked;
  hardwareAccelerationCheckbox.disabled = true;
  try {
    const result = await window.petAPI.setHardwareAcceleration(wanted);
    if (!result || !result.ok) throw new Error(result && result.error || "保存失败");
    hardwareAccelerationSaved = result.hardwareAcceleration === true;
    hardwareAccelerationAtStartup = result.activeHardwareAcceleration === true;
    hardwareAccelerationForcedOff = result.hardwareAccelerationForcedOff === true;
    hardwareAccelerationCheckbox.checked = hardwareAccelerationSaved;
    renderHardwareAccelerationStatus();
  } catch (error) {
    hardwareAccelerationCheckbox.checked = hardwareAccelerationSaved;
    renderHardwareAccelerationStatus(error);
  } finally {
    hardwareAccelerationCheckbox.disabled = false;
  }
};

// ===== 自动切换角色造型 =====
// 勾选后每 10 分钟按当前模式随机切换一次角色和造型；
// 常规模式只在 sfw 列表里抽，成人模式只在 r18 列表里抽，并排除 HCG。
let autoSwitchTimer = null;
const AUTO_SWITCH_INTERVAL_MS = 10 * 60 * 1000;

function isHcgModel(id) {
  return typeof id === "string" && id.startsWith("hcg_");
}

function doAutoSwitch() {
  if (!autoSwitchCheckbox.checked) return;
  const mode = modeSelect.value;
  if (mode !== "sfw" && mode !== "r18") return;

  // 随机角色：有其他角色时随机换，否则保持当前角色
  const currentChar = currentCharacter();
  const targetCharacter = characters.length > 1
    ? characters[Math.floor(Math.random() * characters.length)]
    : currentChar;
  if (!targetCharacter) return;

  // 按当前模式抽取可用造型，排除 HCG
  const ids = (mode === "r18" ? targetCharacter.r18 : targetCharacter.sfw) || [];
  const eligible = ids.filter(id => !isHcgModel(id));
  if (!eligible.length) return;
  const modelId = eligible[Math.floor(Math.random() * eligible.length)];

  // 切角色 + 切造型
  characterSelect.value = targetCharacter.id;
  applyMode(mode, modelId);
}

autoSwitchCheckbox.onchange = () => {
  // 规则写在标签的 title 里（鼠标悬停可见），勾选时不再弹系统提示框
  if (autoSwitchCheckbox.checked) {
    autoSwitchTimer = setInterval(doAutoSwitch, AUTO_SWITCH_INTERVAL_MS);
  } else {
    clearInterval(autoSwitchTimer);
    autoSwitchTimer = null;
  }
};

document.getElementById("clickThrough").onclick = () => {
  clickThrough = true;
  closePanel();
  window.petAPI.setClickThrough(true);
};
document.getElementById("quit").onclick = () => window.petAPI.close();
// ===== AI 对话开关 / 打开配置 =====
if (aiEnabledCheckbox) {
  aiEnabledCheckbox.onchange = async () => {
    if (!window.petAPI || typeof window.petAPI.setAiEnabled !== "function") return;
    const wanted = !!aiEnabledCheckbox.checked;
    aiEnabledCheckbox.disabled = true;
    try {
      aiStatus = await window.petAPI.setAiEnabled(wanted);
    } catch (error) {
      aiStatus = null;
    }
    aiEnabledCheckbox.disabled = false;
    renderAiStatus();
    syncIdleInterval();
    // 关掉时把还在路上的自言自语作废，避免关完又冒一句 AI 台词
    if (!wanted) aiIdleToken++;
  };
}
if (aiSaveButton) {
  aiSaveButton.onclick = async () => {
    if (!window.petAPI || typeof window.petAPI.saveAiConfig !== "function") {
      showAiHint("当前版本不支持在面板里保存配置，请用「配置文件」按钮手动填写。");
      return;
    }
    const key = aiKeyInput ? aiKeyInput.value.trim() : "";
    const model = aiModelInput ? aiModelInput.value.trim() : "";
    aiSaveButton.disabled = true;
    let result = null;
    try {
      result = await window.petAPI.saveAiConfig({ apiKey: key, model });
    } catch (error) {
      result = null;
    }
    aiSaveButton.disabled = false;
    if (!result) {
      showAiHint("保存失败：主进程没有响应。");
      return;
    }
    if (result.status) aiStatus = result.status;
    renderAiStatus();
    syncIdleInterval();
    if (!result.ok) {
      showAiHint(result.error || "保存失败。");
      return;
    }
    if (aiKeyInput) aiKeyInput.value = "";
    if (!result.hasKey) {
      showAiHint("模型已保存，但还没有 Key，仍使用本地台词。");
      return;
    }
    showAiHint(aiStatus && aiStatus.enabled
      ? "已保存，下一句就生效。建议点「测试连接」确认一次。"
      : "已保存。勾选上面的「AI 对话」后生效。");
  };
}

if (aiTestButton) {
  aiTestButton.onclick = async () => {
    if (!window.petAPI || typeof window.petAPI.aiTest !== "function") return;
    aiTestButton.disabled = true;
    showAiHint("正在请求 DeepSeek…");
    const role = currentCharacter();
    let result = null;
    try {
      result = await window.petAPI.aiTest({ roleId: role ? role.id : null });
    } catch (error) {
      result = null;
    }
    aiTestButton.disabled = false;
    if (!result) {
      showAiHint("测试失败：主进程没有响应。");
      return;
    }
    if (result.ok) {
      showAiHint("连接正常（" + Math.max(0, Math.round(result.latencyMs || 0)) + "ms）：" + result.text);
    } else {
      showAiHint("测试失败：" + (result.message || result.reason || "未知原因"));
    }
  };
}

// 清除 Key 是不可撤销的，所以做成"3 秒内再点一次确认"
let aiClearArmedAt = 0;
if (aiClearButton) {
  aiClearButton.onclick = async () => {
    if (!window.petAPI || typeof window.petAPI.saveAiConfig !== "function") return;
    if (Date.now() - aiClearArmedAt > 3000) {
      aiClearArmedAt = Date.now();
      aiClearButton.textContent = "再点一次确认";
      setTimeout(() => { aiClearButton.textContent = "清除 Key"; }, 3200);
      return;
    }
    aiClearArmedAt = 0;
    aiClearButton.textContent = "清除 Key";
    let result = null;
    try {
      result = await window.petAPI.saveAiConfig({ clearKey: true });
    } catch (error) {
      result = null;
    }
    if (!result) {
      showAiHint("清除失败：主进程没有响应。");
      return;
    }
    if (result.status) aiStatus = result.status;
    if (aiKeyInput) aiKeyInput.value = "";
    renderAiStatus();
    syncIdleInterval();
    showAiHint("已清除 Key，之后使用本地台词。");
  };
}

if (aiOpenConfigButton) {
  aiOpenConfigButton.onclick = () => {
    if (window.petAPI && typeof window.petAPI.openAiConfig === "function") window.petAPI.openAiConfig();
  };
}
// 从编辑器切回桌宠时，如果 AI 还没就绪（多半是刚在配置文件里填完 Key），重新问一次状态。
// 用户不需要为了"生效"再开一次设置面板。
window.addEventListener("focus", () => {
  if (!aiStatus || !aiStatus.available) refreshAiStatus();
});
// ===== 角色大小：拖动时用 CSS 缩放预览，松手才真正 resize =====
// 之前 input 事件每动一格就改一次 BrowserWindow 尺寸：透明窗口每次 resize 都要重建
// 合成层、Spine 的 WebGL 画布也跟着重新分配 -> 角色和面板一起屏闪。
// 现在拖动过程只改 #stage 的 transform（GPU 合成，不触发布局、不重建画布），
// 松手(change)后再把真实窗口尺寸一次性提交给主进程。
const BASE_WIDTH = 560;
const BASE_HEIGHT = 760;
let committedScale = 1; // 已经提交给主进程的窗口缩放

// 拖动中的预览只能"缩小"，不能"放大"。
// 预览只是叠在**当前真实窗口**上的 CSS 变换，窗口物理尺寸没变：
//   比例 < 1 -> 内容缩小后完整落在窗口内，安全；
//   比例 > 1 -> 内容超出窗口被 overflow:hidden 裁掉（之前只露出躯干和脚就是这个原因）。
// 所以放大方向不做 CSS 预览，松手(change)时一次性 resize 窗口，让画布自己重排。
function setStagePreview(scale) {
  const preview = committedScale ? scale / committedScale : scale;
  if (preview > 1.0001) {
    stage.style.removeProperty("transform");
    sizeValue.classList.add("pending");
    return;
  }
  sizeValue.classList.remove("pending");
  if (Math.abs(preview - 1) < 0.001) stage.style.removeProperty("transform");
  else stage.style.transform = "scale(" + preview.toFixed(4) + ")";
}

sizeSlider.oninput = () => {
  const percent = Number(sizeSlider.value);
  sizeValue.value = percent + "%";
  setStagePreview(percent / 100);
  saveSettings();
};
sizeSlider.onchange = () => {
  const percent = Number(sizeSlider.value);
  const scale = percent / 100;
  sizeValue.value = percent + "%";
  sizeValue.classList.remove("pending");
  stage.style.removeProperty("transform"); // 预览复位，改由真实窗口尺寸接管
  committedScale = scale;
  applyWindowSize();
  saveSettings();
};
window.petAPI.onClickThroughChanged(value => {
  clickThrough = value;
  markRenderActivity();
  if (value && dialogueBubble) dialogueBubble.hide();
  document.getElementById("clickThrough").textContent = value ? "鼠标穿透已开启" : "开启鼠标穿透";
  // 完全穿透结束后重新按当前光标位置判定，避免状态残留
  __lastPixelHit = null;
});

async function initControlShortcuts() {
  const button = document.getElementById("clickThrough");
  const tips = document.getElementById("shortcutTips");
  button.disabled = true;
  const label = key => String(key).replace("CommandOrControl", "Ctrl");
  try {
    const keys = await window.petAPI.getControlShortcuts();
    const restore = keys && typeof keys.toggle === "string" ? keys.toggle : null;
    const quit = keys && typeof keys.quit === "string" ? keys.quit : null;
    button.disabled = !restore;
    tips.textContent = restore
      ? "穿透后按 " + label(restore) + " 恢复操作。"
      : "恢复快捷键被占用，当前桌宠已禁用完全鼠标穿透。";
    tips.appendChild(document.createElement("br"));
    tips.appendChild(document.createTextNode(quit
      ? label(quit) + " 可退出本桌宠。"
      : "退出请使用上方“退出桌宠”按钮。"));
  } catch (error) {
    tips.textContent = "无法读取恢复快捷键，当前桌宠已禁用完全鼠标穿透。";
  }
}

// 暴露给调试/自动化检查（只读用）
window.petDebug = () => ({
  get dialogue() { return dialogueBubble ? dialogueBubble.debug() : null; },
  // AI 台词状态（不包含 Key）：ready 决定点击是走 AI 还是本地台词
  get ai() {
    return {
      ready: aiReady(),
      status: aiStatus,
      clickToken: aiSpeakToken,
      idleToken: aiIdleToken,
      streak: { ...aiStreak }
    };
  },
  get idle() {
    return {
      enabled: !!(idleDialogue && idleDialogue.enabled),
      intervalMs: currentIdleIntervalMs(),
      aiInterval: aiIdleIntervalMs(),
      sinceActivityMs: Date.now() - lastRenderActivityAt,
      untilNextMs: Math.max(0, currentIdleIntervalMs() - (Date.now() - lastRenderActivityAt)),
      lastSpeakAt: lastIdleSpeakAt,
      watchdog: !!idleWatchdog,
      canSpeak: canSpeakIdleDialogue()
    };
  },
  get player() { return player; },
  get asset() { return currentAsset; },
  get layout() { return layoutController ? layoutController.debug() : null; },
  get layoutProfileCount() { return Object.keys(layoutProfiles).length; },
  get counters() { return { reaction: __c.reaction, anim: __c.anim, pointerup: __c.pointerup, bgMasked: __c.bgMasked }; },
  get lastHit() { return __lastHit; },
  get clickCounts() { return { counts: { ...clickCounts }, timerActive: !!progressionTimer }; },
  get regions() { return Object.keys(REGION_BONES); },
  get pixelHit() { return { enabled: pixelHitEnabled, last: __lastPixelHit }; },
  get scene() {
    return {
      index: sceneStepIndex,
      automatic: sceneAutoPlaying,
      generation: scenePlaybackGeneration,
      holdPending: sceneHoldTimer !== null,
      returnPending: cgReturnTimer !== null
    };
  },
  // Use the real sequence path in scene tests, including faces and queued tracks.
  setSceneStep(index) {
    cancelScenePlayback();
    return playSceneStep(index);
  },
  get performance() {
    return {
      targetFps: frameLimiterFps,
      idle: frameLimiterFps === IDLE_RENDER_FPS,
      activityAgeMs: Date.now() - lastRenderActivityAt,
      hardwareAccelerationSaved,
      hardwareAccelerationAtStartup
    };
  },
  // 静帧轮播的调试信息（自动化测试用）
  get stills() {
    return {
      index: stillsIndex,
      total: (currentAsset && currentAsset.frames || []).length,
      auto: !!stillsTimer,
      frameMs: currentAsset ? currentAsset.frameMs : null,
      rect: stillsContentRect()
    };
  },
  advanceStills() { return advanceStills(); },
  // 测试钩子：模拟部位点击的规则累积（自动化验证用）
  progress(region) { return handleClickProgression(region); },
  setStillsFrame(i) { const v = showStillsFrame(i); startStillsAuto(); return v; },
  // 直接测某个屏幕坐标是否落在角色实体上（自动化用）
  probe(x, y) { return isOpaqueAt(x, y); },
  // 背景遮罩开关（自动化/调试用）
  showBackground(on) {
    if (on) {
      removeBackgroundMask();
      return 0;
    }
    installBackgroundMask(currentAsset);
    return __c.bgMasked;
  },
  bgMaskedSlots() {
    if (!player || !player.skeleton) return [];
    return player.skeleton.slots.filter(s => s.__bgMasked).map(s => s.data.name);
  },
  // 装甲造型的调试信息：每组开关状态 + 当前被摘掉的槽
  get armor() {
    const capable = !!(currentAsset && currentAsset.armor);
    const empty = [];
    if (player && player.skeleton) {
      player.skeleton.slots.forEach(s => {
        if (!s.getAttachment() && armorGroupOf(s.data.name)) empty.push(s.data.name);
      });
    }
    return { capable, state: { ...armorState }, hiddenCount: empty.length, hiddenSlots: empty, companion: __c.companion || null, companionCfg: (currentAsset && currentAsset.companion) || null };
  },
  // 供测试用：骨骼坐标 -> 屏幕坐标（反推点击点）
  skeletonToScreen(x, y) {
    const canvas = document.querySelector("#player canvas");
    const vp = player && (player.currentViewport || player.viewport);
    if (!canvas || !vp) return null;
    const rect = canvas.getBoundingClientRect();
    const px = ((x - vp.x) / vp.width) * canvas.width;
    const py = (1 - (y - vp.y) / vp.height) * canvas.height;
    return { x: rect.left + px * (rect.width / canvas.width),
             y: rect.top + py * (rect.height / canvas.height) };
  }
});

// 测试钩子：自动化脚本用它对当前造型手动触发伴生注入（ bone 矩阵对比等诊断用 ）
window.__injectForTest = async () => {
  if (player && currentAsset && currentAsset.companion) {
    await injectCompanionSkeleton(player, currentAsset.companion);
  }
};

initHardwareAccelerationSetting();
initControlShortcuts();

// Register before the asset Promise: a failed character/data load must not
// prevent the tray from opening this existing settings panel.
if (window.petAPI.onOpenSettings) {
  window.petAPI.onOpenSettings(requestId => {
    openPanel();
    if (window.petAPI.settingsOpened) window.petAPI.settingsOpened(requestId);
  });
}

// Both ZIP routes notify this existing folder-based loader after commit.
let importRefreshGeneration = 0;
let initialCharacterConfigReady = false;
let queuedImportedCharacter = null;
function showCharacterImportResult(result) {
  const node = document.getElementById("characterImportStatus");
  if (!node || !result) return;
  node.textContent = result.message || "";
  node.dataset.error = String(!result.ok && !result.duplicate && !result.canceled);
}
async function refreshImportedCharacters(result) {
  if (!initialCharacterConfigReady) { queuedImportedCharacter = result; return; }
  const generation = ++importRefreshGeneration;
  try {
    const config = await window.petAPI.loadConfig();
    if (generation !== importRefreshGeneration) return;
    const previousAsset = currentAsset;
    assets = (config.assets || []).map(asset => previousAsset && asset.id === previousAsset.id ? previousAsset : asset);
    characters = config.characters || [];
    layoutProfiles = config.layoutProfiles || {};
    if (dialogueBubble) dialogueBubble.setData(config.dialogues || { roles: {} });
    renderCharacterOptions();
    const target = characters.find(character => character.id === result.characterId) || characters[0];
    if (target) applyCharacter(target.id);
    setEmptyState(!characters.length);
    await refreshAiStatus();
    showCharacterImportResult(result);
  } catch (error) {
    showCharacterImportResult({ ok: false, message: "角色已安装，但列表刷新失败，请重启桌宠：" + error.message });
  }
}
async function importCharacterFromDialog(button) {
  if (button) button.disabled = true;
  showCharacterImportResult({ ok: true, message: "请选择角色ZIP，选择后将自动校验并导入…" });
  try { showCharacterImportResult(await window.petAPI.importCharacterZip()); }
  catch (error) { showCharacterImportResult({ ok: false, message: "导入失败：" + error.message }); }
  finally { if (button) button.disabled = false; }
}

async function openCharacterImportDirectory() {
  try { showCharacterImportResult(await window.petAPI.openCharacterImportDirectory()); }
  catch (error) { showCharacterImportResult({ ok: false, message: error.message }); }
}

function initCharacterImports() {
  if (!window.petAPI || typeof window.petAPI.importCharacterZip !== "function") return;
  const button = document.getElementById("importCharacter");
  const directoryButton = document.getElementById("openCharacterImports");
  if (window.petAPI.onCharactersImported) window.petAPI.onCharactersImported(refreshImportedCharacters);
  if (window.petAPI.onCharacterImportResult) window.petAPI.onCharacterImportResult(showCharacterImportResult);
  button.onclick = () => importCharacterFromDialog(button);
  directoryButton.onclick = openCharacterImportDirectory;
  // 空角色引导卡上的同一套入口（没有角色时这是唯一看得见的按钮）
  const emptyImport = document.getElementById("emptyImport");
  const emptyDirectory = document.getElementById("emptyOpenDirectory");
  const emptySettings = document.getElementById("emptyOpenSettings");
  const emptyQuit = document.getElementById("emptyQuit");
  if (emptyImport) emptyImport.onclick = () => importCharacterFromDialog(emptyImport);
  if (emptyDirectory) emptyDirectory.onclick = openCharacterImportDirectory;
  if (emptySettings) emptySettings.onclick = () => openPanel();
  // 没有角色时也必须能直接退出：否则用户只能去托盘右键，很多人找不到
  if (emptyQuit) emptyQuit.onclick = () => window.petAPI.close();
  if (window.petAPI.getCharacterImportStatus) window.petAPI.getCharacterImportStatus().then(status => {
    if (!status) return;
    document.getElementById("characterImportDirectory").textContent = "自动导入目录：" + status.directory;
    if (status.results && status.results.length) showCharacterImportResult(status.results[status.results.length - 1]);
  }).catch(error => showCharacterImportResult({ ok: false, message: error.message }));
}
initCharacterImports();

// 设置面板里显示"角色数据目录"：打包后程序目录只读，用户必须能知道角色到底装在哪
function initRuntimeInfo() {
  const node = document.getElementById("dataDirectory");
  if (!node || !window.petAPI || typeof window.petAPI.getRuntimeInfo !== "function") return;
  window.petAPI.getRuntimeInfo().then(info => {
    if (!info || !info.dataRoot) return;
    node.textContent = "角色数据目录：" + info.dataRoot;
    node.title = info.dataRoot;
  }).catch(() => {});
}
initRuntimeInfo();

// 角色配置是"按目录装载"的：characters/<id>/ 有几个目录就有几个角色，
// 没装的角色不会出现（也不会占安装体积）。扫描合并交给主进程，这里只取结果。
(window.petAPI && window.petAPI.loadConfig
  ? window.petAPI.loadConfig()
  : Promise.reject(new Error("petAPI.loadConfig 不可用")))
  .catch(error => {
    console.warn("[pet] 角色配置加载失败：", error && error.message ? error.message : error);
    return { assets: [], characters: [], layoutProfiles: {}, dialogues: { roles: {} } };
  })
  .then(config => {
    assets = (config && config.assets) || [];
    characters = (config && config.characters) || [];
    layoutProfiles = (config && config.layoutProfiles) || {};
    if (!characters.length) console.warn("[pet] characters/ 下没有已装载的角色");
    if (dialogueBubble) dialogueBubble.setData((config && config.dialogues) || { roles: {} });
    if (idleDialogue) idleDialogue.reset();
    startIdleWatchdog();
    // AI 状态要在角色数据之后问：主进程需要 characters/<id>/persona.json 才算"可用"
    refreshAiStatus();

    // 角色栏：默认第一个角色（五峰山君李泰虎），上次选过别的角色就沿用
    renderCharacterOptions();
    const wanted = characters.some(item => item.id === saved.character)
      ? saved.character
      : (characters[0] && characters[0].id);
    if (wanted) characterSelect.value = wanted;

    // 每次启动固定：常规模式 + 初始造型 + 各造型 base.face（统一 Face_01）+ Idle
    modeSelect.value = DEFAULT.mode;
    applyDevUnlock();                       // 决定"开发者模式"这一行是否显示
    devModeCheckbox.checked = Boolean(saved.devMode);
    // 显示范围微调也回填到滑块上（值存的是小数，滑块是整数百分比）
    dispZoomSlider.value = String(Math.round(displayZoom * 100));
    dispZoomValue.value = dispZoomSlider.value + "%";
    dispXSlider.value = String(Math.round(displayOffsetX * 100));
    dispXValue.value = dispXSlider.value + "%";
    dispYSlider.value = String(Math.round(displayOffsetY * 100));
    dispYValue.value = dispYSlider.value + "%";
    applyDevMode();
    applyDisplayAdjust();
    // 窗口尺寸：回到上次记住的缩放。
    // 注意先把 saved.size 写回滑块、再按滑块值 resize —— 否则滑块显示的是
    // 上次的尺寸，而窗口却按 HTML 默认值（100%）创建，两者对不上。
    sizeSlider.value = saved.size || DEFAULT.size;
    sizeValue.value = sizeSlider.value + "%";
    const initScale = Number(sizeSlider.value) / 100;
    committedScale = initScale;
    applyWindowSize();

    applyMode(DEFAULT.mode, DEFAULT.model);
    setEmptyState(!characters.length);
    initialCharacterConfigReady = true;
    if (queuedImportedCharacter) {
      const imported = queuedImportedCharacter; queuedImportedCharacter = null;
      refreshImportedCharacters(imported);
    }
  });
