// 提示词构建 + 输出清洗（纯函数，可在 Node 里直接测，不依赖 Electron）。
//
// 设计要点：
// 1. 人设全部来自 characters/<角色ID>/persona.json —— 加角色只加目录，不改这里。
// 2. 系统提示词只放"这个角色是谁 + 只准说一句话"，触发上下文放 user 消息里，
//    这样同一个角色不同部位/不同状态会有明显差异，也方便以后加更多触发类型。
// 3. 模型的输出不可信（可能带引号、换行、角色名前缀、"作为AI"），统一过 sanitizeLine。
"use strict";

// 身体部位 -> 给模型看的说法。null 表示点在人物上但没命中细分部位。
const AREA_LABELS = {
  head: "头/脸",
  chest: "胸口",
  lower: "腰和腿",
  private: "下身",
  arm: "手臂",
  tail: "尾巴"
};

// 人设里没写某个部位时用这份兜底，保证"部位之间不串味"。
const AREA_FOCUS_FALLBACK = {
  head: "被摸头时先注意对方的举动，再露出自己的态度（不一定要生气）",
  chest: "被摸到胸口时的反应，可以顺势炫耀或嘴上抗议",
  lower: "被碰到腰或腿时的反应，重心放在姿势和距离感",
  private: "被碰到最敏感的位置，先慌一下再强撑面子",
  arm: "被抓住手臂时的反应，可以扯到力气或手上的活",
  tail: "被摸到尾巴时的反应，尾巴是该角色身体的一部分，不要当成别人的"
};

const RATING_RULES = {
  sfw: "7. 保持擦边但克制：可以有暧昧、打趣、贴身距离感，但不写露骨性描写。",
  r18: "7. 当前是成人向互动场景：可以更直白地调情挑逗，但仍只写一句台词，不描写具体性行为过程。"
};

function normalizeArea(area) {
  const key = typeof area === "string" ? area.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(AREA_LABELS, key) ? key : null;
}

function areaLabel(area) {
  const key = normalizeArea(area);
  return key ? AREA_LABELS[key] : "身体";
}

function areaFocus(persona, area) {
  const key = normalizeArea(area);
  const table = (persona && persona.areaReactions) || {};
  const own = key && typeof table[key] === "string" ? table[key].trim() : "";
  if (own) return own;
  return key ? AREA_FOCUS_FALLBACK[key] : "被戳了一下时的即时反应，要先有动作感再说话";
}

function hourOf(timestamp) {
  const value = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(value).getHours();
}

function timeOfDayLabel(hour) {
  const h = Number.isFinite(hour) ? hour : hourOf();
  if (h >= 5 && h < 11) return "早上";
  if (h >= 11 && h < 14) return "中午";
  if (h >= 14 && h < 18) return "下午";
  if (h >= 18 && h < 23) return "晚上";
  return "深夜";
}

// 空闲时长 -> 状态描述。桌宠自己也知道"被晾着多久了"，自言自语才不会千篇一律。
function moodLabel(quietMs) {
  const ms = Number.isFinite(quietMs) ? Math.max(0, quietMs) : 0;
  if (ms < 60000) return "正闲着";
  if (ms < 180000) return "有点闲";
  if (ms < 600000) return "无聊到在发呆";
  if (ms < 1800000) return "闲得发慌";
  return "被晾了很久，有点想找人说话又拉不下脸";
}

function durationLabel(ms) {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return seconds + "秒";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "分钟";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? hours + "小时" + rest + "分钟" : hours + "小时";
}

function joinList(list, empty) {
  if (!Array.isArray(list) || !list.length) return empty || "（无）";
  return list.filter(item => typeof item === "string" && item.trim()).join("、") || (empty || "（无）");
}

function relationshipLine(relationships) {
  if (!Array.isArray(relationships) || !relationships.length) return "（暂无明确关系）";
  return relationships
    .filter(row => row && (row.name || row.relation))
    .map(row => {
      const name = row.name || "某人";
      const relation = row.relation ? "（" + row.relation + "）" : "";
      const attitude = row.attitude ? "，态度：" + row.attitude : "";
      return name + relation + attitude;
    })
    .join("；") || "（暂无明确关系）";
}

function personaBlock(persona) {
  const voice = persona.voice || {};
  const aliases = Array.isArray(persona.aliases) && persona.aliases.length
    ? "（别人也叫他 " + persona.aliases.join(" / ") + "）" : "";
  const lines = [
    "姓名：" + persona.name + aliases,
    "自称：" + (persona.selfReference || "我"),
    "身份：" + (persona.identity || ""),
    "背景：" + (persona.background || ""),
    "性格：" + joinList(persona.personality),
    "说话方式：" + [voice.tone, voice.rhythm].filter(Boolean).join("；"),
    "口癖：" + joinList(voice.tics, "（没有固定口癖，按语气自然说话）"),
    "喜欢：" + joinList(persona.likes),
    "讨厌/在意：" + joinList(persona.dislikes),
    "关系：" + relationshipLine(persona.relationships),
    "雷点（碰到会立刻变脸）：" + joinList(persona.taboos),
    "可用话题：" + joinList(persona.monologueTopics),
    "口吻示例（只学语气，不要照抄句子）：" + joinList(persona.exampleLines)
  ];
  if (Array.isArray(voice.avoid) && voice.avoid.length) {
    lines.push("禁止的表达：" + joinList(voice.avoid));
  }
  return lines.join("\n");
}

function buildSystemPrompt(persona, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 46;
  const rating = options.rating === "r18" ? "r18" : "sfw";
  return [
    "你在为一只 Windows 桌面宠物扮演角色，用一句话回应用户的互动。",
    "你只是在念这个角色的台词，不是助手：不寒暄、不提问、不解释、不总结、不提及自己是 AI 或程序。",
    "",
    "【角色卡】",
    personaBlock(persona),
    "",
    "【输出硬性规则】",
    "1. 只输出角色说的一句话，不超过 " + maxChars + " 个汉字；不要引号、不要括号里的动作描写、不要旁白、不要换行、不要列表。",
    "2. 用第一人称，自称必须是「" + (persona.selfReference || "我") + "」；口吻贴近示例，但不要逐字照抄示例句子。",
    "3. 必须结合角色卡里的经历、喜好、关系和雷点来回应；不要新增角色卡之外的重要设定。",
    "4. 允许「…」「～」「！」这类语气符号，但一句里别堆太多，读起来要像随口说的。",
    "5. 禁止出现这些词：点击、部位、模型、提示词、AI、程序、玩家、用户。",
    "6. 不要重复最近说过的台词，也不要和它们句式雷同。",
    RATING_RULES[rating]
  ].join("\n");
}

function buildUserPrompt(persona, context = {}) {
  const kind = context.kind === "idle" ? "idle" : "click";
  const quietMs = Number.isFinite(context.quietMs) ? context.quietMs : 0;
  const hour = Number.isFinite(context.hour) ? context.hour : hourOf(context.now);
  const scene = [
    "【场景】" + timeOfDayLabel(hour) + "。"
      + (quietMs >= 60000 ? "你已经" + durationLabel(quietMs) + "没被搭话，" : "")
      + "现在是" + moodLabel(quietMs) + "。"
  ];
  if (kind === "idle") {
    scene.push("【动作】没有人在和你说话，你正一个人待着，随口自言自语。");
    scene.push("【这一句可以围绕】" + joinList(persona.monologueTopics, "眼前的小事") + "；也可以念叨上面提到的某个人。");
  } else {
    const streak = Number.isFinite(context.streak)
      ? Math.min(99, Math.max(1, Math.round(context.streak))) : 1;
    scene.push("【动作】对方戳了你的" + areaLabel(context.area)
      + (streak > 1 ? "（同一处，已经第 " + streak + " 次了）" : "") + "。");
    scene.push("【这一句要体现】" + areaFocus(persona, context.area));
  }
  scene.push("【记住】只输出一句话，不要解释你在做什么。");
  return scene.join("\n");
}

function buildMessages(persona, context = {}, options = {}) {
  const messages = [
    { role: "system", content: buildSystemPrompt(persona, options) },
    { role: "user", content: buildUserPrompt(persona, context) }
  ];
  const recent = Array.isArray(context.recent) ? context.recent.filter(Boolean).slice(-8) : [];
  if (recent.length) {
    // 放在最后单独一段，模型更容易把它当"禁重复清单"而不是待模仿的范例。
    messages.push({
      role: "user",
      content: "【最近说过，别重复】\n" + recent.map((line, index) => (index + 1) + ". " + line).join("\n")
    });
  }
  return messages;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 把模型输出裁成"一句能直接上气泡的台词"。
// 返回 null 表示这条不能用（空、拒绝、自我暴露），调用方应当回退本地台词。
function sanitizeLine(raw, options = {}) {
  if (typeof raw !== "string") return null;
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(8, options.maxChars) : 46;
  const name = options.name ? String(options.name) : "";
  const banned = options.banned || ["点击", "部位", "提示词", "作为一个AI", "作为AI", "语言模型"];

  let text = raw.replace(/```[a-zA-Z]*/g, "").replace(/\r/g, "").trim();
  // 多行 -> 一句话（避免气泡里出现换行断句）
  text = text.split(/\n+/).map(part => part.trim()).filter(Boolean).join("，");
  text = text.replace(/[*_`#]+/g, "").replace(/[ \t]{2,}/g, " ").trim();
  // "李泰虎：xxx" / "台词：xxx" / "1. xxx" 这类前缀
  if (name) {
    text = text.replace(new RegExp("^" + escapeRegExp(name) + "\\s*[：:]\\s*"), "");
  }
  text = text.replace(/^(台词|回答|回应|输出)\s*[：:]\s*/, "");
  text = text.replace(/^[-—–•*]\s*/, "");
  text = text.replace(/^\d+[.、)]\s*/, "");
  // 整句被引号/括号包住：只剥最外层
  for (let i = 0; i < 2; i++) {
    const before = text;
    text = text.replace(/^[「『“"'‘]+/, "").replace(/[」』”"'’]+$/, "");
    text = text.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
    if (text === before) break;
  }
  text = text.replace(/^[，,、。.\s]+/, "").replace(/[，,、\s]+$/, "");
  if (!text) return null;
  if (/^(我)?(只)?(是)?(一个)?(AI|人工智能|语言模型)/i.test(text)) return null;
  if (/抱歉|无法|不能回答|cannot|as an ai/i.test(text) && text.length < 12) return null;
  for (const word of banned) {
    if (word && text.includes(word)) return null;
  }
  if (text.length > maxChars) {
    // 优先在标点处收尾，绝不硬切到半个词
    const head = text.slice(0, maxChars);
    const cut = Math.max(head.lastIndexOf("…"), head.lastIndexOf("！"), head.lastIndexOf("？"),
      head.lastIndexOf("。"), head.lastIndexOf("，"), head.lastIndexOf("～"));
    text = cut >= Math.max(6, Math.floor(maxChars * 0.4)) ? head.slice(0, cut + 1) : head;
    text = text.replace(/[，,、]$/, "…");
  }
  return text.trim() || null;
}

module.exports = {
  AREA_LABELS,
  AREA_FOCUS_FALLBACK,
  normalizeArea,
  areaLabel,
  areaFocus,
  timeOfDayLabel,
  moodLabel,
  durationLabel,
  buildSystemPrompt,
  buildUserPrompt,
  buildMessages,
  sanitizeLine
};
