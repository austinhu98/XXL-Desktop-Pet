(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PetDialogue = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function bubblePlacement(viewport, size, anchor) {
    const width = Math.max(1, Number(viewport.width) || 1);
    const height = Math.max(1, Number(viewport.height) || 1);
    const margin = Math.min(12, width / 4, height / 4);
    const w = Math.max(1, Math.min(size.width || 1, width - margin * 2));
    const h = Math.max(1, Math.min(size.height || 1, height - margin * 2));
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    const pointX = Number.isFinite(anchor.x) ? anchor.x : width / 2;
    const pointY = Number.isFinite(anchor.y) ? anchor.y : height * 0.20;
    const head = [anchor.left, anchor.right, anchor.top, anchor.bottom].every(Number.isFinite)
      ? anchor : { left: pointX - 28, right: pointX + 28, top: pointY - 28, bottom: pointY + 28 };
    const cx = (head.left + head.right) / 2;
    const cy = (head.top + head.bottom) / 2;
    const gap = 12;
    const safe = { left: head.left - gap, right: head.right + gap,
      top: head.top - gap, bottom: head.bottom + gap };
    // Prefer the user's reference: a horizontal bubble above the head.
    // If that does not fit, try beside the head, then below the protected face.
    // Clamping may move a candidate back onto the face, so reject overlaps AFTER clamping.
    const candidates = [
      { left: cx - w / 2, top: safe.top - h, placement: "above" },
      { left: safe.right, top: cy - h / 2, placement: "right" },
      { left: safe.left - w, top: cy - h / 2, placement: "left" },
      { left: cx - w / 2, top: safe.bottom, placement: "below" }
    ];
    for (const candidate of candidates) {
      const left = clamp(candidate.left, margin, width - w - margin);
      const top = clamp(candidate.top, margin, height - h - margin);
      const overlap = left < safe.right && left + w > safe.left
        && top < safe.bottom && top + h > safe.top;
      if (overlap) continue;
      return { left, top, tailX: clamp(cx - left, Math.min(18, w / 2), Math.max(w - 18, w / 2)),
        tailY: clamp(cy - top, Math.min(18, h / 2), Math.max(h - 18, h / 2)), placement: candidate.placement };
    }
    // If the face really fills the window, hiding is preferable to covering it.
    return null;
  }

  const headSlotCache = new WeakMap();

  function projectHeadBounds(instance, runtime) {
    const skeleton = instance && instance.skeleton;
    const canvas = instance && instance.canvas;
    const camera = instance && instance.sceneRenderer && instance.sceneRenderer.camera;
    if (!skeleton || !canvas || !camera || !runtime || !runtime.Vector3) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let cached = headSlotCache.get(skeleton);
    if (!cached || cached.count !== skeleton.slots.length) {
      const head = skeleton.bones.find(bone => /^head2?$/i.test(bone.data.name))
        || skeleton.bones.find(bone => /^head[_-]?(main|root)$/i.test(bone.data.name));
      if (!head) return null;
      const slots = skeleton.slots.filter(slot => {
        const name = slot.data.name.replace(/([a-z])([A-Z])/g, "$1_$2");
        if (/(^|_)(head\d*|face\d*|faces|hair\d*|ear[lr]?\d*|brow\d*|eye[slr]?\d*|mouth\d*|nose\d*|jaw\d*)(_|$)/i.test(name)) return true;
        for (let bone = slot.bone; bone; bone = bone.parent) if (bone === head) return true;
        return false;
      });
      cached = { head, slots, count: skeleton.slots.length };
      headSlotCache.set(skeleton, cached);
    }
    const project = (x, y) => {
      const point = camera.worldToScreen(new runtime.Vector3(x, y, 0), rect.width, rect.height);
      return { x: rect.left + point.x, y: rect.top + rect.height - point.y };
    };
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const slot of cached.slots) {
      const attachment = slot.getAttachment();
      if (!attachment || slot.color.a <= 0) continue;
      let vertices;
      if (attachment instanceof runtime.RegionAttachment) {
        vertices = new Float32Array(8);
        attachment.computeWorldVertices(slot, vertices, 0, 2);
      } else if (attachment instanceof runtime.MeshAttachment) {
        vertices = new Float32Array(attachment.worldVerticesLength);
        attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
      } else continue;
      for (let i = 0; i < vertices.length; i += 2) {
        const point = project(vertices[i], vertices[i + 1]);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        left = Math.min(left, point.x); right = Math.max(right, point.x);
        top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
      }
    }
    if (Number.isFinite(left) && right > left && bottom > top) return { left, right, top, bottom };
    const point = project(cached.head.worldX, cached.head.worldY);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { left: point.x - 36, right: point.x + 36, top: point.y - 46, bottom: point.y + 32 };
  }

  function textDuration(text) {
    return Math.min(12000, Math.max(4000, Array.from(text).length * 90));
  }

  class DialogueBubble {
    constructor(element, options) {
      const opts = options || {};
      this.element = element;
      this.random = opts.random || Math.random;
      // Browser timer functions require the Window receiver. Calling a stored
      // native function as this.schedule() binds it to this controller instead
      // and Chromium throws "Illegal invocation". Keep native calls lexical.
      this.schedule = opts.setTimeout || ((callback, delay) => setTimeout(callback, delay));
      this.cancel = opts.clearTimeout || (id => clearTimeout(id));
      this.getViewport = opts.getViewport || (() => ({ width: window.innerWidth, height: window.innerHeight }));
      this.getHeadBounds = opts.getHeadBounds || (() => null);
      this.now = opts.now || Date.now;
      this.lastFollowAt = -Infinity;
      this.data = {};
      this.lastText = new Map();
      this.timer = null;
      this.generation = 0;
      this.visible = false;
      this.roleId = null;
      this.line = null;
      this.suppressedForSpace = false;
      this.headSourceFailed = false;
    }

    setData(data) {
      this.hide();
      this.data = data && data.roles && typeof data.roles === "object" ? data.roles : {};
      this.lastText.clear();
    }

    hide() {
      this.generation++;
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
      this.visible = false;
      this.roleId = null;
      this.line = null;
      this.suppressedForSpace = false;
      this.headSourceFailed = false;
      if (this.element) {
        this.element.classList.add("hidden");
        this.element.classList.remove("pending");
        this.element.textContent = "";
      }
    }

    // AI 台词还没回来时的占位（"……"）：气泡立刻出现，不会让人觉得点了没反应。
    // 不写 lastText，也不参与本地台词池的"不连续重复"判断。
    pending(roleId, text) {
      this.hide();
      if (!this.element) return false;
      this.element.textContent = typeof text === "string" && text ? text : "……";
      this.element.classList.remove("hidden");
      this.element.classList.add("pending");
      this.visible = true;
      this.roleId = roleId;
      this.line = null;
      this.reposition();
      const generation = this.generation;
      // 安全阀：AI 一直不回来也不能长期占着气泡（正常路径会先把它替换掉）
      this.timer = this.schedule(() => {
        if (generation === this.generation) this.hide();
      }, 9000);
      return true;
    }

    // 直接显示一句外部给的台词（AI 生成结果）。计时/避让规则与 show() 一致。
    showText(roleId, text, options) {
      const value = typeof text === "string" ? text.trim() : "";
      if (!value) return null;
      this.hide();
      if (!this.element) return null;
      this.roleId = roleId;
      this.line = { id: null, text: value };
      this.lastText.set(roleId, value);
      this.element.classList.remove("pending");
      this.element.textContent = value;
      this.element.classList.remove("hidden");
      this.visible = true;
      this.reposition();
      const generation = this.generation;
      this.timer = this.schedule(() => {
        if (generation === this.generation) this.hide();
      }, textDuration(value));
      return value;
    }

    show(roleId, options) {
      this.hide();
      if (!this.element) return null;
      const role = Object.prototype.hasOwnProperty.call(this.data, roleId) ? this.data[roleId] : null;
      const lines = dialoguePool(role, options);
      if (!lines.length) return null;
      const last = this.lastText.get(roleId);
      const alternatives = lines.filter(row => row.text !== last);
      const pool = alternatives.length ? alternatives : lines;
      const random = Math.max(0, Math.min(0.999999999, Number(this.random()) || 0));
      const line = pool[Math.floor(random * pool.length)];
      this.lastText.set(roleId, line.text);
      this.roleId = roleId;
      this.line = line;
      this.element.textContent = line.text;
      this.element.classList.remove("hidden");
      this.visible = true;
      this.reposition();
      const generation = this.generation;
      this.timer = this.schedule(() => {
        if (generation === this.generation) this.hide();
      }, textDuration(line.text));
      return line.id || null;
    }

    reposition() {
      if (!this.visible || !this.element) return;
      const viewport = this.getViewport();
      this.element.style.maxWidth = Math.max(1, Math.min(300, viewport.width - 24)) + "px";
      this.element.style.maxHeight = Math.max(1, viewport.height - 24) + "px";
      // An earlier small window may have suppressed the bubble. Measure it with
      // its normal display again, without scaling its font or width with Spine.
      this.element.classList.remove("hidden");
      const size = this.element.getBoundingClientRect();
      let measuredHead = null;
      if (!this.headSourceFailed) {
        try { measuredHead = this.getHeadBounds(); }
        catch (error) { this.headSourceFailed = true; }
      }
      const head = measuredHead || {
        left: viewport.width * 0.4, right: viewport.width * 0.6,
        top: viewport.height * 0.10, bottom: viewport.height * 0.25
      };
      const placement = bubblePlacement(viewport, size, head);
      this.suppressedForSpace = placement === null;
      if (!placement) {
        this.element.classList.add("hidden");
        return;
      }
      this.element.style.left = Math.round(placement.left) + "px";
      this.element.style.top = Math.round(placement.top) + "px";
      this.element.style.setProperty("--dialogue-tail-x", Math.round(placement.tailX) + "px");
      this.element.style.setProperty("--dialogue-tail-y", Math.round(placement.tailY) + "px");
      this.element.dataset.placement = placement.placement;
    }

    followHead() {
      // No extra render loop: use the player's completed frames, at most 12.5 Hz,
      // and only while a bubble is visible. This does not affect animation FPS.
      const now = this.now();
      if (!this.visible || now - this.lastFollowAt < 80) return;
      this.lastFollowAt = now;
      this.reposition();
    }

    debug() {
      const classList = this.element && this.element.classList;
      return { visible: this.visible, roleId: this.roleId, lineId: this.line && this.line.id,
        pending: !!(classList && typeof classList.contains === "function" && classList.contains("pending")),
        timerPending: this.timer !== null, roleCount: Object.keys(this.data).length,
        suppressedForSpace: this.suppressedForSpace, headSourceFailed: this.headSourceFailed };
    }
  }

  function dialoguePool(role, options = {}) {
    if (!role || !Array.isArray(role.lines)) return [];
    const valid = role.lines.filter(row => row && typeof row.text === "string" && row.text.trim());
    const bindings = role.bindings || {};
    const bound = new Set(Object.values(bindings).filter(Array.isArray).flat().map(String));
    const ids = options.kind !== "idle" && Array.isArray(bindings[options.area])
      ? new Set(bindings[options.area].map(String)) : null;
    // Empty/missing area uses general lines, never another body's pool.
    // Compute the complement at runtime so a stale idleLineIds cannot leak a
    // newly bound line into idle speech.
    return ids && ids.size ? valid.filter(row => ids.has(String(row.id)))
      : valid.filter(row => !bound.has(String(row.id)));
  }

  class IdleDialogueScheduler {
    constructor(options = {}) {
      this.interval = options.intervalMs || 300000;
      this.schedule = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
      this.cancel = options.clearTimeout || (id => clearTimeout(id));
      this.canSpeak = options.canSpeak || (() => true);
      this.onSpeak = options.onSpeak || (() => {});
      this.enabled = false;
      this.timer = null;
      this.generation = 0;
    }
    stop() {
      this.enabled = false;
      this.generation++;
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
    }
    reset() {
      this.stop();
      this.enabled = true;
      this.arm();
    }
    arm() {
      const generation = this.generation;
      this.timer = this.schedule(() => {
        if (!this.enabled || generation !== this.generation) return;
        this.timer = null;
        try { if (this.canSpeak()) this.onSpeak(); }
        finally { if (this.enabled && generation === this.generation) this.arm(); }
      }, this.interval);
    }
  }

  function pointInPolygon(point, polygon) {
    if (!polygon || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j], b = polygon[i];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;
      const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
      if (Math.abs(cross) < 1e-6 && point.x >= Math.min(a.x, b.x) - 1e-6
        && point.x <= Math.max(a.x, b.x) + 1e-6 && point.y >= Math.min(a.y, b.y) - 1e-6
        && point.y <= Math.max(a.y, b.y) + 1e-6) return true;
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function detectDialogueArea(instance, runtime, role, clientX, clientY, options = {}) {
    const skeleton = instance && instance.skeleton;
    const canvas = instance && instance.canvas;
    const camera = instance && instance.sceneRenderer && instance.sceneRenderer.camera;
    if (!skeleton || !canvas || !camera || !runtime || !runtime.Vector3) return { area: null, available: false };
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { area: null, available: false };
    const world = new runtime.Vector3(clientX - rect.left, clientY - rect.top, 0);
    camera.screenToWorld(world, rect.width, rect.height);
    const settings = (role && role.touchSettings || []).filter(row => !row.isSpecificSkinSetting
      || Number(row.specificSkinId) === Number(options.variant));
    // A dedicated skin setting takes precedence over the default role setting.
    const specific = settings.filter(row => row.isSpecificSkinSetting);
    const areas = (specific.length ? specific : settings).flatMap(row => options.yiff
      ? row.yiffTouchAreaDatas || [] : row.touchAreaDatas || []);
    const matches = [];
    let available = false;
    for (const entry of areas) {
      if (entry.hasSpecificSkinId && Number(entry.specificSkinId) !== Number(options.variant)) continue;
      // These flags select alternative private-area colliders, not all body areas.
      if (Number(entry.areaId) === 3 && entry.hasSpecificSkinId
        && (!!entry.isR15 !== !!options.r15 || !!entry.isErectOn !== !!options.erect)) continue;
      const bone = skeleton.bones.find(b => String(b.data.name).toLowerCase() === String(entry.boneName).toLowerCase());
      if (!bone || bone.active === false || !entry.colliderPoints || entry.colliderPoints.length < 3) continue;
      const det = bone.a * bone.d - bone.b * bone.c;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) continue;
      available = true;
      const dx = world.x - bone.worldX, dy = world.y - bone.worldY;
      const local = { x: (dx * bone.d - dy * bone.b) / det, y: (dy * bone.a - dx * bone.c) / det };
      if (pointInPolygon(local, entry.colliderPoints)) matches.push(entry);
    }
    // Area 0 is a broad lower/body polygon; precise regions win overlaps.
    const priority = { 0: 1, 1: 2, 2: 3, 3: 4 };
    matches.sort((a, b) => (priority[b.areaId] || 0) - (priority[a.areaId] || 0));
    const names = { 0: "lower", 1: "chest", 2: "head", 3: "private" };
    return { area: matches.length ? names[matches[0].areaId] || null : null, available };
  }

  return { DialogueBubble, bubblePlacement, textDuration, projectHeadBounds,
    dialoguePool, IdleDialogueScheduler, pointInPolygon, detectDialogueArea };
});
