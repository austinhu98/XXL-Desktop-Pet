// DeepSeek 台词服务（主进程侧）。
//
// 为什么放在主进程：
//   · API Key 不能进渲染进程（渲染层是网页上下文，CSP 也不允许外连）；
//   · 网络请求、超时、重试、缓存、失败冷却都在这里做，渲染层只拿到"一句台词"；
//   · 人设/配置都在文件系统里，加角色只加 characters/<id>/persona.json。
//
// 对外只暴露四个动作：
//   request(payload) -> { ok, text, source, reason }  取一句（可能来自缓存）
//   status()         -> 给面板/调试看的快照（绝不返回完整 Key）
//   setEnabled(bool) -> 用户在面板上开关（写 userData，不改配置文件）
//   flush()          -> 等所有在途请求结束（测试用）
"use strict";
const fs = require("fs");
const path = require("path");
const promptKit = require("./ai/prompt");

const DEFAULTS = {
  enabled: true,
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  temperature: 1.1,
  maxTokens: 160,
  timeoutMs: 4500,
  maxLineChars: 46,
  rating: "sfw",
  allowAdultInR18Mode: false,
  idleIntervalMs: 600000,
  prefetch: true,
  cachePerKey: 2,
  // 前台节流：两次真正发往接口的请求至少间隔这么久，连点时其余点击直接用本地台词
  minRequestGapMs: 2000,
  // 一分钟内最多发多少条前台请求（兜底，防止脚本/连点刷爆）
  maxRequestsPerMinute: 20,
  minPrefetchGapMs: 20000,
  maxPrefetchPerMinute: 10,
  // 预取不在生成完立刻发，而是等用户停手这么久之后再补一条，避免"点一次付两次"
  prefetchDelayMs: 7000,
  maxConsecutiveFailures: 3,
  cooldownMs: 60000,
  recentLimit: 8,
  log: false
};

const FAILURE_TEXT = {
  "no-persona": "该角色没有人设文件，使用本地台词",
  "no-api-key": "未配置 API Key，使用本地台词",
  "no-fetch": "当前运行环境没有 fetch，使用本地台词",
  disabled: "未开启 AI 对话（在设置面板勾选后生效），使用本地台词",
  "disabled-by-flag": "本次启动带 --no-ai，已禁用 AI 对话，使用本地台词",
  cooldown: "连续请求失败，暂时回退到本地台词",
  throttled: "点击太快，这句先用本地台词",
  timeout: "请求超时，使用本地台词",
  network: "网络不可用，使用本地台词",
  "key-invalid": "API Key 无效（401/403），使用本地台词",
  "insufficient-balance": "账户余额不足（402），使用本地台词",
  "rate-limited": "请求过于频繁（429），使用本地台词",
  "unusable-output": "模型输出不可用，使用本地台词",
  "api-error": "接口返回错误，使用本地台词"
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return stat.mtimeMs + ":" + stat.size;
  } catch (error) {
    return "0";
  }
}

function clampNumber(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

function createAiDialogue(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const charsDir = options.charsDir || path.join(root, "characters");
  const configPath = options.configPath || path.join(root, "ai-config.json");
  const localConfigPath = options.localConfigPath || path.join(root, "ai-config.local.json");
  const userSettingsPath = options.userSettingsPath || path.join(root, "work", "ai-settings.json");
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const logger = options.logger || console;
  // 开发/测试约定：启动参数 --no-ai 时强制关闭，面板开关也不生效
  const forceDisabled = options.forceDisabled === true;

  let config = Object.assign({}, DEFAULTS);
  let signature = "";
  let personas = new Map();
  const cache = new Map();
  const recent = new Map();
  const inflight = new Map();
  const prefetchAt = new Map();
  const background = new Set();
  let prefetchTimes = [];
  let failures = 0;
  let cooldownUntil = 0;
  let lastError = "";
  let lastErrorAt = 0;
  let lastLatencyMs = 0;
  let lastForegroundAt = 0;
  let requestTimes = [];
  const prefetchTimers = new Map();
  const stats = { ok: 0, fail: 0, cache: 0, prefetch: 0 };

  function log(...args) {
    if (config.log && logger && typeof logger.info === "function") logger.info("[ai]", ...args);
  }

  // ===== 配置 =====
  function loadConfig() {
    let next = Object.assign({}, DEFAULTS, readJsonSafe(configPath, {}) || {});
    const local = readJsonSafe(localConfigPath, null);
    if (local && typeof local === "object") next = Object.assign(next, local);
    const envName = typeof next.apiKeyEnv === "string" ? next.apiKeyEnv : "";
    const envKey = envName ? env[envName] : "";
    if (typeof envKey === "string" && envKey.trim()) next.apiKey = envKey.trim();
    next.apiKey = typeof next.apiKey === "string" ? next.apiKey.trim() : "";
    config = next;
    signature = fileSignature(configPath) + "|" + fileSignature(localConfigPath);
    return config;
  }

  // 用户改了 ai-config.json（比如换了 Key）不用重启，下一次请求自动生效。
  function reloadIfNeeded() {
    const next = fileSignature(configPath) + "|" + fileSignature(localConfigPath);
    if (next !== signature) {
      loadConfig();
      // 顺手重扫人设：新装角色/补了 persona.json 时不必重启
      loadPersonas();
      log("配置已重新加载");
      return true;
    }
    return false;
  }

  function readUserEnabled() {
    const saved = readJsonSafe(userSettingsPath, null);
    // 没有保存过 = 默认关闭。AI 是用户手动开启的功能，绝不默认接管台词。
    return !!(saved && saved.enabled === true);
  }

  function effectiveEnabled() {
    // 配置文件里的 enabled:false 是硬开关（整机禁用），正常开关只有面板那一个。
    if (forceDisabled) return false;
    if (config.enabled === false) return false;
    return readUserEnabled() === true;
  }

  function setEnabled(enabled) {
    const saved = readJsonSafe(userSettingsPath, {}) || {};
    saved.enabled = Boolean(enabled);
    try {
      writeJsonSafe(userSettingsPath, saved);
    } catch (error) {
      log("写入开关失败", error && error.message);
    }
    return status();
  }

  // 面板上直接改 Key / 模型：写到 ai-config.local.json（本地覆盖，不动模板文件）。
  // 返回值里带上最新 status，渲染层一次刷新到位。
  function saveConfig(patch = {}) {
    const local = readJsonSafe(localConfigPath, {}) || {};
    if (patch.clearKey) local.apiKey = "";
    if (typeof patch.apiKey === "string") {
      // 允许直接粘 "Bearer sk-..." 或带引号的写法，统一洗成裸 Key
      const key = patch.apiKey.trim()
        .replace(/^Bearer\s+/i, "")
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .trim();
      if (key) {
        if (key.length < 8) return { ok: false, error: "Key 看起来不完整（至少 8 个字符）", status: status() };
        if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: "Key 里不能有空格或中文", status: status() };
        local.apiKey = key;
      }
    }
    if (patch.clearModel) delete local.model;
    if (typeof patch.model === "string" && patch.model.trim()) {
      const model = patch.model.trim();
      if (!/^[A-Za-z0-9._-]{2,64}$/.test(model)) {
        return { ok: false, error: "模型名不合法（只允许字母、数字、点、横线）", status: status() };
      }
      local.model = model;
    }
    try {
      writeJsonSafe(localConfigPath, local);
    } catch (error) {
      return { ok: false, error: "写入失败：" + (error && error.message ? error.message : error), status: status() };
    }
    // 换 Key/模型后旧的缓存和失败计数都不再可信
    loadConfig();
    clearPrefetchTimers();
    failures = 0;
    cooldownUntil = 0;
    lastError = "";
    lastForegroundAt = 0;
    requestTimes = [];
    cache.clear();
    prefetchAt.clear();
    log("配置已保存", { hasKey: !!config.apiKey, model: config.model });
    return { ok: true, hasKey: !!config.apiKey, status: status() };
  }

  // 「测试连接」：绕过面板开关和冷却，真发一次，专门用来看 Key/网络/余额有没有问题。
  async function testConnection(roleId) {
    if (forceDisabled) return { ok: false, reason: "disabled-by-flag", message: FAILURE_TEXT["disabled-by-flag"] };
    reloadIfNeeded();
    if (!fetchImpl) return { ok: false, reason: "no-fetch", message: FAILURE_TEXT["no-fetch"] };
    if (!config.apiKey) return { ok: false, reason: "no-api-key", message: FAILURE_TEXT["no-api-key"] };
    const persona = personas.get(String(roleId || "")) || personas.values().next().value;
    if (!persona) return { ok: false, reason: "no-persona", message: FAILURE_TEXT["no-persona"] };
    const started = now();
    try {
      const text = await callApi(persona, "click", "head", { streak: 1, quietMs: 0, mode: "sfw" });
      failures = 0;
      cooldownUntil = 0;
      lastError = "";
      return { ok: true, text, latencyMs: now() - started, model: config.model, provider: config.provider };
    } catch (error) {
      const reason = error.reason || "error";
      return {
        ok: false,
        reason,
        message: FAILURE_TEXT[reason] || "接口返回错误（" + reason + "）",
        latencyMs: now() - started
      };
    }
  }

  // ===== 人设 =====
  function loadPersonas() {
    const map = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(charsDir, { withFileTypes: true });
    } catch (error) {
      log("characters 目录不可读", error && error.message);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const installed = readJsonSafe(path.join(charsDir, entry.name, "character.json"), null);
      if (!installed || typeof installed !== "object" || installed.id == null) continue;
      const file = path.join(charsDir, entry.name, "persona.json");
      const persona = readJsonSafe(file, null);
      if (!persona || typeof persona !== "object") continue;
      const id = String(persona.id || entry.name);
      if (id !== String(installed.id)) continue;
      if (map.has(id)) {
        log("跳过重复角色人设:", id, entry.name);
        continue;
      }
      if (!persona.name || !persona.identity) {
        log("跳过人设不完整的目录:", entry.name);
        continue;
      }
      map.set(id, persona);
    }
    personas = map;
    return map;
  }

  // ===== 请求 =====
  function maxChars() {
    return Math.round(clampNumber(config.maxLineChars, 12, 90, DEFAULTS.maxLineChars));
  }

  function timeoutMs() {
    return Math.round(clampNumber(config.timeoutMs, 800, 20000, DEFAULTS.timeoutMs));
  }

  function idleIntervalMs() {
    return Math.round(clampNumber(config.idleIntervalMs, 30000, 1800000, DEFAULTS.idleIntervalMs));
  }

  function cachePerKey() {
    return Math.round(clampNumber(config.cachePerKey, 1, 4, DEFAULTS.cachePerKey));
  }

  function ratingFor(payload) {
    if (config.rating !== "r18") return "sfw";
    return config.allowAdultInR18Mode && payload && payload.mode === "r18" ? "r18" : "sfw";
  }

  function endpoint() {
    let base = String(config.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(base)) return base;
    if (!/\/v\d+$/i.test(base)) base += "/v1";
    return base + "/chat/completions";
  }

  function keyHint() {
    const key = config.apiKey || "";
    if (!key) return "";
    if (key.length <= 8) return "已配置";
    return key.slice(0, 4) + "…" + key.slice(-4);
  }

  function tagError(reason, cause) {
    const error = new Error(reason);
    error.reason = reason;
    error.cause = cause;
    return error;
  }

  function noteFailure(reason, error) {
    failures++;
    lastError = reason;
    lastErrorAt = now();
    stats.fail++;
    if (error && config.log) log("请求失败", reason, error && error.message);
    if (failures >= Math.max(1, Number(config.maxConsecutiveFailures) || 3)) {
      cooldownUntil = now() + clampNumber(config.cooldownMs, 5000, 600000, DEFAULTS.cooldownMs);
      failures = 0;
      log("进入冷却，直到", new Date(cooldownUntil).toISOString());
    }
  }

  async function callApi(persona, kind, area, payload) {
    const messages = promptKit.buildMessages(persona, {
      kind,
      area,
      streak: payload && payload.streak,
      quietMs: payload && payload.quietMs,
      hour: payload && payload.hour,
      now: now(),
      recent: (recent.get(persona.id) || []).slice(-Math.max(1, Number(config.recentLimit) || 8))
    }, { maxChars: maxChars(), rating: ratingFor(payload) });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    let response;
    try {
      response = await fetchImpl(endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.apiKey
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: clampNumber(config.temperature, 0, 2, 1.1),
          max_tokens: Math.round(clampNumber(config.maxTokens, 32, 800, DEFAULTS.maxTokens)),
          stream: false
        }),
        signal: controller.signal
      });
    } catch (error) {
      throw tagError(error && error.name === "AbortError" ? "timeout" : "network", error);
    } finally {
      clearTimeout(timer);
    }

    if (!response || !response.ok) {
      const statusCode = response ? response.status : 0;
      const reason = (statusCode === 401 || statusCode === 403) ? "key-invalid"
        : statusCode === 402 ? "insufficient-balance"
        : statusCode === 429 ? "rate-limited"
        : "http-" + statusCode;
      throw tagError(reason);
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      throw tagError("api-error", error);
    }
    if (data && data.error) throw tagError("api-error", data.error);
    const content = data && Array.isArray(data.choices) && data.choices[0]
      && data.choices[0].message ? data.choices[0].message.content : "";
    const text = promptKit.sanitizeLine(content, { maxChars: maxChars(), name: persona.name });
    if (!text) throw tagError("unusable-output");
    return text;
  }

  function pushRecent(roleId, text) {
    const list = recent.get(roleId) || [];
    list.push(text);
    const limit = Math.max(1, Number(config.recentLimit) || 8);
    while (list.length > limit) list.shift();
    recent.set(roleId, list);
  }

  function cacheKey(roleId, kind, area) {
    return roleId + "|" + kind + "|" + (area || "-");
  }

  async function runGeneration(persona, kind, area, payload) {
    const startedAt = now();
    try {
      const text = await callApi(persona, kind, area, payload);
      failures = 0;
      stats.ok++;
      lastLatencyMs = now() - startedAt;
      lastError = "";
      pushRecent(persona.id, text);
      log("生成", persona.name, kind, area || "-", (now() - startedAt) + "ms", text);
      return text;
    } catch (error) {
      noteFailure(error.reason || "error", error);
      return null;
    }
  }

  // 前台请求：同一个角色+部位同时只发一条，快速连点不会堆出一堆请求。
  async function generate(key, persona, kind, area, payload) {
    if (inflight.has(key)) return inflight.get(key);
    const task = runGeneration(persona, kind, area, payload);
    inflight.set(key, task);
    task.finally(() => inflight.delete(key));
    return task;
  }

  // 后台补货：把下一句提前生成好放进缓存，下次点击就不用等网络。
  // 预取走独立通道（不占用前台 inflight），否则用户点在预取途中会拿到同一句、并重复出现。
  function prefetchBudgetOk() {
    const cutoff = now() - 60000;
    prefetchTimes = prefetchTimes.filter(at => at >= cutoff);
    const limit = Math.round(clampNumber(config.maxPrefetchPerMinute, 0, 60, DEFAULTS.maxPrefetchPerMinute));
    if (prefetchTimes.length >= limit) return false;
    prefetchTimes.push(now());
    return true;
  }

  // 连点节流：缓存命中不花钱，所以只拦"真要发网络请求"的那一次。
  function foregroundBudgetOk() {
    const stamp = now();
    const gap = clampNumber(config.minRequestGapMs, 0, 60000, DEFAULTS.minRequestGapMs);
    if (stamp - lastForegroundAt < gap) return false;
    const limit = Math.round(clampNumber(config.maxRequestsPerMinute, 1, 120, DEFAULTS.maxRequestsPerMinute));
    requestTimes = requestTimes.filter(at => stamp - at < 60000);
    return requestTimes.length < limit;
  }

  function clearPrefetchTimers() {
    for (const timer of prefetchTimers.values()) clearTimeout(timer);
    prefetchTimers.clear();
  }

  // 预取不在生成完立刻发：等用户停手 prefetchDelayMs 之后再补一条。
  // 这样"连点 5 下"最多只花 1 次请求，而不是每下 2 次。
  function schedulePrefetch(key, persona, kind, area, payload) {
    if (!config.prefetch) return;
    const delay = Math.round(clampNumber(config.prefetchDelayMs, 0, 600000, DEFAULTS.prefetchDelayMs));
    const existing = prefetchTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      prefetchTimers.delete(key);
      fillCache(key, persona, kind, area, payload, true);
    }, delay);
    prefetchTimers.set(key, timer);
  }

  function fillCache(key, persona, kind, area, payload, force) {
    if (!config.prefetch) return null;
    if (now() < cooldownUntil) return null;
    const bucket = cache.get(key) || [];
    if (bucket.length >= cachePerKey()) return null;
    const last = prefetchAt.get(key) || 0;
    const gap = force ? 0 : clampNumber(config.minPrefetchGapMs, 0, 600000, DEFAULTS.minPrefetchGapMs);
    if (now() - last < gap) return null;
    if (!prefetchBudgetOk()) return null;
    prefetchAt.set(key, now());
    stats.prefetch++;
    const task = runGeneration(persona, kind, area, payload)
      .then(text => {
        if (!text) return null;
        const list = cache.get(key) || [];
        if (list.length < cachePerKey() && !list.includes(text)) list.push(text);
        cache.set(key, list);
        return text;
      })
      .catch(() => null);
    background.add(task);
    task.finally(() => background.delete(task));
    return task;
  }

  function fail(reason, extra) {
    return Object.assign({
      ok: false,
      text: "",
      source: "local",
      reason,
      message: FAILURE_TEXT[reason] || "AI 不可用，使用本地台词"
    }, extra || {});
  }

  function availabilityReason() {
    if (forceDisabled) return "disabled-by-flag";
    if (!effectiveEnabled()) return "disabled";
    if (!config.apiKey) return "no-api-key";
    if (!fetchImpl) return "no-fetch";
    if (!personas.size) return "no-persona";
    return "";
  }

  async function request(payload = {}) {
    const roleId = String(payload.roleId || "");
    const kind = payload.kind === "idle" ? "idle" : "click";
    const area = kind === "click" ? promptKit.normalizeArea(payload.area) : null;
    const persona = personas.get(roleId);
    reloadIfNeeded();
    const reason = availabilityReason();
    if (!persona) return fail("no-persona");
    if (reason) return fail(reason);
    if (now() < cooldownUntil) return fail("cooldown", { retryInMs: cooldownUntil - now() });

    const key = cacheKey(roleId, kind, area);
    // 用户又在点：先取消还没到点的后台预取，别在他连点时花钱
    clearPrefetchTimers();
    const bucket = cache.get(key) || [];
    if (bucket.length) {
      const text = bucket.shift();
      cache.set(key, bucket);
      stats.cache++;
      // 缓存用掉一条，等用户停手后再补一条
      schedulePrefetch(key, persona, kind, area, payload);
      return { ok: true, text, source: "cache" };
    }

    // 连点保护：两次真正请求之间至少隔 minRequestGapMs，超出分钟预算也直接回退本地
    if (!foregroundBudgetOk()) return fail("throttled");
    lastForegroundAt = now();
    requestTimes.push(lastForegroundAt);

    const text = await generate(key, persona, kind, area, payload);
    if (!text) return fail(lastError || "error");
    schedulePrefetch(key, persona, kind, area, payload);
    return { ok: true, text, source: "ai" };
  }

  function status() {
    reloadIfNeeded();
    const reason = availabilityReason();
    return {
      ok: true,
      enabled: reason !== "disabled" && reason !== "disabled-by-flag",
      available: reason === "",
      reason,
      provider: config.provider || DEFAULTS.provider,
      model: config.model,
      endpoint: endpoint(),
      personaCount: personas.size,
      personaIds: Array.from(personas.keys()).sort(),
      idleIntervalMs: idleIntervalMs(),
      maxLineChars: maxChars(),
      timeoutMs: timeoutMs(),
      rating: config.rating === "r18" ? "r18" : "sfw",
      allowAdultInR18Mode: !!config.allowAdultInR18Mode,
      prefetch: !!config.prefetch,
      disabledByFlag: forceDisabled,
      prefetchDelayMs: Math.round(clampNumber(config.prefetchDelayMs, 0, 600000, DEFAULTS.prefetchDelayMs)),
      minRequestGapMs: Math.round(clampNumber(config.minRequestGapMs, 0, 60000, DEFAULTS.minRequestGapMs)),
      maxRequestsPerMinute: Math.round(clampNumber(config.maxRequestsPerMinute, 1, 120, DEFAULTS.maxRequestsPerMinute)),
      keyHint: keyHint(),
      lastError,
      lastErrorAt,
      lastErrorText: FAILURE_TEXT[lastError] || "",
      lastLatencyMs,
      cooldownRemainingMs: Math.max(0, cooldownUntil - now()),
      configPath,
      localConfigPath,
      stats: Object.assign({}, stats)
    };
  }

  async function flush() {
    // 到点的预取定时器先放它跑（测试里 prefetchDelayMs 设 0）
    if (prefetchTimers.size) await new Promise(resolve => setTimeout(resolve, 10));
    const pending = Array.from(inflight.values()).concat(Array.from(background));
    if (pending.length) await Promise.allSettled(pending);
    // 预取完成后可能又产生新的在途任务，再收一轮
    if (inflight.size || background.size) {
      await Promise.allSettled(Array.from(inflight.values()).concat(Array.from(background)));
    }
  }

  loadConfig();
  loadPersonas();
  const savedEnabled = readUserEnabled();
  log("初始化完成：人设", personas.size, "可用", availabilityReason() === "", "开关", savedEnabled);

  return {
    request,
    status,
    setEnabled,
    saveConfig,
    testConnection,
    flush,
    reload() {
      loadConfig();
      loadPersonas();
      clearPrefetchTimers();
      cache.clear();
      recent.clear();
      prefetchAt.clear();
      failures = 0;
      cooldownUntil = 0;
      lastError = "";
      lastForegroundAt = 0;
      requestTimes = [];
      return status();
    },
    get configPath() { return configPath; },
    // 测试用：直接看缓存/最近台词，不对外暴露 Key
    debugState() {
      return {
        cache: Array.from(cache.entries()).map(([key, lines]) => [key, lines.slice()]),
        recent: Object.fromEntries(Array.from(recent.entries()).map(([id, lines]) => [id, lines.slice()])),
        inflight: Array.from(inflight.keys()),
        failures,
        cooldownUntil,
        lastError
      };
    }
  };
}

module.exports = { createAiDialogue, DEFAULTS, FAILURE_TEXT };
