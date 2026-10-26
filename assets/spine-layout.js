(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SpineLayout = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_LAYOUT = Object.freeze({
    targetBodyRatio: 0.78,
    targetBaselineRatio: 0.08,
    safeMarginRatio: 0.065,
    // Normal desktop-pet window is 560x760. Wider debug/square windows add
    // horizontal room but must not change the character's visual scale.
    canonicalAspect: 560 / 760,
    // 右侧给设置面板预留的宽度（按窗口高度折算的比例）。角色模式统一开，
    // 面板就不会压在人物身上；场景/静帧不开（CG 本来就该铺满）。
    panelReserveAspect: 0
  });

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function validBounds(bounds) {
    return !!bounds && finite(bounds.x) && finite(bounds.y) &&
      finite(bounds.w) && finite(bounds.h) && bounds.w > 0 && bounds.h > 0;
  }

  function clamp(value, low, high) {
    if (!finite(low) || !finite(high) || low > high) return value;
    return Math.min(Math.max(value, low), high);
  }

  function clampFit(value, low, high) {
    if (!finite(low) || !finite(high)) return value;
    // Floating point rounding can invert an exactly-fitting interval by a few
    // ulps. Centering the two limits preserves containment in that case.
    if (low > high) return (low + high) / 2;
    return Math.min(Math.max(value, low), high);
  }

  function chooseBounds(profile, animationName) {
    const special = profile && profile.animationLayouts && profile.animationLayouts[animationName];
    if (special && validBounds(special.bounds || special)) return special.bounds || special;
    return profile && validBounds(profile.motionBounds) ? profile.motionBounds : null;
  }

  function unionProfileBounds(profile) {
    const rows = [];
    if (profile && validBounds(profile.motionBounds)) rows.push(profile.motionBounds);
    const layouts = profile && profile.animationLayouts;
    if (layouts) {
      for (const value of Object.values(layouts)) {
        const bounds = value && (value.bounds || value);
        if (validBounds(bounds)) rows.push(bounds);
      }
    }
    if (!rows.length) return null;
    const minX = Math.min(...rows.map(row => row.x));
    const minY = Math.min(...rows.map(row => row.y));
    const maxX = Math.max(...rows.map(row => row.x + row.w));
    const maxY = Math.max(...rows.map(row => row.y + row.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function computeViewport(profile, animationName, canvasWidth, canvasHeight, adjustment) {
    if (!profile || !profile.anchor) return null;
    const bounds = chooseBounds(profile, animationName);
    if (!bounds || !finite(canvasWidth) || !finite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) return null;

    const layout = Object.assign({}, DEFAULT_LAYOUT, profile.layout || {});
    const bodyHeight = finite(profile.anchor.bodyHeight) && profile.anchor.bodyHeight > 0
      ? profile.anchor.bodyHeight : bounds.h;
    const anchorX = finite(profile.anchor.x) ? profile.anchor.x : bounds.x + bounds.w / 2;
    const baselineY = finite(profile.anchor.baselineY) ? profile.anchor.baselineY : bounds.y;
    const marginRatioX = clamp(Number(
      finite(layout.safeMarginXRatio) ? layout.safeMarginXRatio : layout.safeMarginRatio
    ), 0, 0.2);
    const marginRatioY = clamp(Number(
      finite(layout.safeMarginYRatio) ? layout.safeMarginYRatio : layout.safeMarginRatio
    ), 0, 0.2);
    const targetBodyRatio = clamp(Number(layout.targetBodyRatio), 0.2, 0.95);
    const targetBaselineRatio = clamp(Number(layout.targetBaselineRatio), 0.02, 0.3);
    const user = adjustment || {};
    const requestedZoom = clamp(finite(user.zoom) ? user.zoom : 1, 0.25, 2.5);

    const canonicalAspect = clamp(Number(layout.canonicalAspect), 0.25, 2);
    const referenceHeight = canvasHeight;
    const referenceWidth = layout.autoExpandWidth === true
      ? canvasWidth
      : Math.min(canvasWidth, canvasHeight * canonicalAspect);
    const desiredScale = referenceHeight * targetBodyRatio / bodyHeight * requestedZoom;
    const safeScale = Math.min(
      referenceWidth * (1 - marginRatioX * 2) / bounds.w,
      referenceHeight * (1 - marginRatioY * 2) / bounds.h
    );
    const scale = Math.min(desiredScale, safeScale);
    if (!finite(scale) || scale <= 0) return null;

    const width = canvasWidth / scale;
    const height = canvasHeight / scale;
    const marginWorldX = referenceWidth * marginRatioX / scale;
    const marginWorldY = referenceHeight * marginRatioY / scale;
    const offsetX = clamp(finite(user.offsetX) ? user.offsetX : 0, -0.3, 0.3) * width;
    const offsetY = clamp(finite(user.offsetY) ? user.offsetY : 0, -0.3, 0.3) * height;
    let x = anchorX - width / 2 + offsetX;
    let y = baselineY - height * targetBaselineRatio + offsetY;

    // 面板预留：窗口按 requiredCanvasAspect 加宽了 panelReserveAspect*高度 像素，
    // 这里把画面左移一半，多出来的宽度就全在右侧（人物在屏幕上位置不变）。
    const panelReservePx = clamp(Number(layout.panelReserveAspect) || 0, 0, 1) * referenceHeight;
    if (panelReservePx > 0) x += panelReservePx / (2 * scale);

    // Keep every sampled visible attachment inside the viewport. Offsets are
    // intentionally clamped instead of being allowed to introduce cropping.
    x = clampFit(x, bounds.x + bounds.w + marginWorldX - width, bounds.x - marginWorldX);
    y = clampFit(y, bounds.y + bounds.h + marginWorldY - height, bounds.y - marginWorldY);

    return {
      x, y, width, height, scale,
      bounds,
      limitedBySafety: safeScale + 1e-9 < desiredScale,
      animationName: animationName || null,
      referenceWidth,
      referenceHeight
    };
  }

  function requiredCanvasAspect(profile, animationName, adjustment) {
    if (!profile || !profile.anchor) return DEFAULT_LAYOUT.canonicalAspect;
    // Window width stays stable while animations change. Include every
    // precomputed special-action envelope instead of resizing on each click.
    const bounds = unionProfileBounds(profile) || chooseBounds(profile, animationName);
    if (!bounds) return DEFAULT_LAYOUT.canonicalAspect;
    const layout = Object.assign({}, DEFAULT_LAYOUT, profile.layout || {});
    const bodyHeight = finite(profile.anchor.bodyHeight) && profile.anchor.bodyHeight > 0
      ? profile.anchor.bodyHeight : bounds.h;
    const marginRatio = clamp(Number(
      finite(layout.safeMarginXRatio) ? layout.safeMarginXRatio : layout.safeMarginRatio
    ), 0, 0.2);
    const targetBodyRatio = clamp(Number(layout.targetBodyRatio), 0.2, 0.95);
    const user = adjustment || {};
    const zoom = clamp(finite(user.zoom) ? user.zoom : 1, 0.25, 2.5);
    const contentAspect = bounds.w * targetBodyRatio * zoom /
      (bodyHeight * (1 - marginRatio * 2));
    const reserveAspect = clamp(Number(layout.panelReserveAspect) || 0, 0, 1);
    return Math.max(Number(layout.canonicalAspect) || DEFAULT_LAYOUT.canonicalAspect,
      contentAspect + reserveAspect);
  }

  function liveBounds(player) {
    const skeleton = player && player.skeleton;
    const runtime = typeof spine !== "undefined" ? spine : null;
    if (!skeleton || !runtime || !runtime.Vector2) return null;
    const offset = new runtime.Vector2();
    const size = new runtime.Vector2();
    try {
      skeleton.getBounds(offset, size, []);
    } catch (error) {
      return null;
    }
    const bounds = { x: offset.x, y: offset.y, w: size.x, h: size.y };
    return validBounds(bounds) ? bounds : null;
  }

  function fallbackProfile(player, asset) {
    const bounds = liveBounds(player);
    if (!bounds) return null;
    return {
      assetId: asset && asset.id,
      roleId: asset && asset.roleId,
      mode: "fallback",
      anchor: {
        x: bounds.x + bounds.w / 2,
        baselineY: bounds.y,
        bodyHeight: bounds.h,
        source: "live-bounds-fallback"
      },
      motionBounds: bounds,
      animationLayouts: {},
      layout: Object.assign({}, DEFAULT_LAYOUT, { targetBodyRatio: 0.72, safeMarginRatio: 0.1 })
    };
  }

  class SpineLayoutController {
    constructor(player, asset, profile, options) {
      this.player = player;
      this.asset = asset || {};
      this.profile = profile || null;
      this.options = options || {};
      this.animationName = this.options.animationName || null;
      this.adjustment = { zoom: 1, offsetX: 0, offsetY: 0 };
      this.lastLayout = null;
      this.diagnostics = [];
      this._applying = false;
      this._install();
    }

    _diagnose(code, detail) {
      const item = { code, assetId: this.asset.id || null, detail: detail || null, at: Date.now() };
      this.diagnostics.push(item);
      if (this.diagnostics.length > 20) this.diagnostics.shift();
      if (typeof console !== "undefined" && console.warn) console.warn("[SpineLayout]", code, item.assetId, detail || "");
    }

    _install() {
      const player = this.player;
      if (!player || typeof player.setViewport !== "function") {
        this._diagnose("NO_SET_VIEWPORT");
        return;
      }
      // A player instance may only have one layout owner. This deliberately
      // replaces no method other than the runtime's original setViewport.
      const original = player.__layoutOriginalSetViewport || player.setViewport.bind(player);
      player.__layoutOriginalSetViewport = original;
      const self = this;
      player.setViewport = function () {
        const result = original.apply(player, arguments);
        self.apply("runtime-setViewport");
        return result;
      };
      player.__spineLayoutController = this;
    }

    setAnimationName(name) {
      this.animationName = name || null;
      this.apply("animation");
    }

    setAdjustment(adjustment) {
      this.adjustment = Object.assign({ zoom: 1, offsetX: 0, offsetY: 0 }, adjustment || {});
      this.apply("adjustment");
    }

    setProfile(profile) {
      this.profile = profile || null;
      this.apply("profile");
    }

    apply(reason) {
      if (this._applying || !this.player) return this.lastLayout;
      const canvas = this.player.canvas || document.querySelector("#player canvas");
      const width = canvas && (canvas.width || canvas.clientWidth);
      const height = canvas && (canvas.height || canvas.clientHeight);
      let profile = this.profile;
      if (!profile || !validBounds(profile.motionBounds)) {
        profile = fallbackProfile(this.player, this.asset);
        if (!profile) {
          this._diagnose("PROFILE_MISSING_AND_FALLBACK_FAILED", reason);
          return null;
        }
        this._diagnose("USING_LIVE_BOUNDS_FALLBACK", reason);
      }
      const layout = computeViewport(profile, this.animationName, width, height, this.adjustment);
      const viewport = this.player.currentViewport || this.player.viewport;
      if (!layout || !viewport) {
        this._diagnose("LAYOUT_NOT_APPLIED", { reason, width, height });
        return null;
      }
      this._applying = true;
      viewport.x = layout.x;
      viewport.y = layout.y;
      viewport.width = layout.width;
      viewport.height = layout.height;
      this._applying = false;
      this.lastLayout = Object.assign({ reason, profileMode: profile.mode }, layout);
      return this.lastLayout;
    }

    dispose() {
      const player = this.player;
      if (player && player.__spineLayoutController === this && player.__layoutOriginalSetViewport) {
        player.setViewport = player.__layoutOriginalSetViewport;
        delete player.__spineLayoutController;
      }
    }

    debug() {
      return {
        assetId: this.asset.id || null,
        animationName: this.animationName,
        profileAvailable: !!this.profile,
        companionRequired: !!(this.profile && this.profile.companionRequired),
        lastLayout: this.lastLayout,
        diagnostics: this.diagnostics.slice()
      };
    }
  }

  return {
    DEFAULT_LAYOUT,
    validBounds,
    computeViewport,
    requiredCanvasAspect,
    fallbackProfile,
    SpineLayoutController
  };
});
