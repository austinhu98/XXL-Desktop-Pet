// ===== 伴生骨架注入引擎（供 renderer.js 与诊断工具共用）=====
// 独立成文件的原因：tools/ 下的自动化脚本（骨矩阵对比等）也要在独立页面里
// 对 bw_test 执行同样的注入，逻辑必须与桌宠运行时完全一致，不能各抄一份。
// 依赖：全局 spine（spine-player.min.js）。用法：await injectCompanionSkeleton(player, cfg)
// ===== 伴生骨架注入（「白威测试」）=====
// 以「白威脱衣R18」（bw_1_r18）为主骨架 —— 基础裸体身体、脸部表情、Erect 状态
// 全部原生保留；把「白威黑化」（90711）作为可勾选的覆盖层注入：
//   1) 独有骨骼（armor_* / belt_* / Boss_* / Fx 等约 100 根）按拓扑序 append，
//      setup 从伴生骨架原样拷贝（父骨按名映射，伴生 bones 数组父先子后）。
//   2) 独有槽位（兜帽/肩甲/腰带/裤子/鞋/红眼/发光/特效/耳环独有槽）append，
//      附件挂进主骨架 default 皮肤，由换装面板的槽开关控制显隐。
//   3) 共有槽位（base_tail / base_chest 等）的黑化附件不进 default，
//      而是按 cfg.overlaySkins 分组建独立覆盖皮肤（DarkBody / DarkTail / DarkEars），
//      勾选对应开关时 applySkin 把它叠加进合并皮肤，取消即回到原生白毛。
//   4) 伴生的 Idle/Hit 动画重映射骨骼/槽位下标后替换主骨架同名动画 ——
//      黑化部件绑定的独有骨只有这套动画有关键帧（Idle 驱动 53 根独有骨），
//      不注入就会静止穿模；共有骨的曲线与原生同源，白毛身体动作不受影响。
// 两套动画均无 drawOrder / attachment 关键帧（已探测），注入槽的绘制顺序
// 手动排一次即永久稳定。附件 region 直接指向主图集（单页，无跨纹理问题）。
window.injectCompanionSkeleton = async function (player, cfg) {
  const skel = player.skeleton, data = skel.data;

  // 1) 收集主图集的全部 region（单页图集，任取一个附件的 page 就能拿全）
  const regionByName = new Map();
  for (const slot of skel.slots) {
    const at = slot.getAttachment();
    if (at && at.region && at.region.page && !at.region.page.__rg) {
      at.region.page.__rg = true;
      for (const r of at.region.page.regions) regionByName.set(r.name, r);
    }
  }
  if (!regionByName.size) throw new Error("companion: 没拿到主图集 region");

  // 2) 用自定义 loader 解析伴生骨架，附件 region 全部指向主图集
  const compUrl = cfg.skeleton.startsWith("assets/") ? cfg.skeleton : "assets/" + cfg.skeleton;
  const resp = await fetch(compUrl);
  if (!resp.ok) throw new Error("companion skel 404: " + compUrl);
  const buf = await resp.arrayBuffer();
  const loader = {
    newRegionAttachment: (s, n, p) => {
      const a = new spine.RegionAttachment(n); a.region = regionByName.get(p || n) || null; return a;
    },
    newMeshAttachment: (s, n, p) => {
      const a = new spine.MeshAttachment(n); a.region = regionByName.get(p || n) || null; return a;
    },
    newBoundingBoxAttachment: (s, n) => new spine.BoundingBoxAttachment(n),
    newPathAttachment: (s, n) => new spine.PathAttachment(n),
    newPointAttachment: (s, n) => new spine.PointAttachment(n),
    newClippingAttachment: (s, n) => new spine.ClippingAttachment(n)
  };
  const comp = new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(buf));

  // 3) 骨骼：共有骨记映射；独有骨按拓扑序 append（伴生 bones 数组父先子后）
  const boneIdx = new Map();   // 伴生骨下标 -> 主骨架下标（重映射权重用）
  let injectedBones = 0;
  comp.bones.forEach((b, i) => {
    const exist = data.findBone(b.name);
    if (exist) { boneIdx.set(i, data.bones.indexOf(exist)); return; }
    if (!cfg.injectBones) { boneIdx.set(i, 0); return; } // 不注入时缺失骨退化为 Main
    const pCompIdx = b.parent ? comp.bones.indexOf(b.parent) : -1;
    const pIdx = pCompIdx >= 0 && boneIdx.has(pCompIdx) ? boneIdx.get(pCompIdx) : -1;
    const parentBD = pIdx >= 0 ? data.bones[pIdx] : null;
    // 本工程 spine-player 的 BoneData 构造是 (index, name, parent) 三参
    const nd = new spine.BoneData(data.bones.length, b.name, parentBD);
    nd.x = b.x; nd.y = b.y; nd.rotation = b.rotation;
    nd.scaleX = b.scaleX; nd.scaleY = b.scaleY; nd.length = b.length;
    // shear 不拷会差旋转和缩放：90711 的装甲骨大量用剪切造型
    nd.shearX = b.shearX; nd.shearY = b.shearY;
    // 这版 runtime 的字段名是 transformMode（决定局部→世界矩阵的组合方式，
    // 装甲骨大量用 noScale/noRotationOrReflection 之类），漏拷会导致缩放被父骨污染
    nd.transformMode = b.transformMode;
    // 注意：绝不能拷贝 skinRequired —— 4.x 里 skinRequired=true 的骨必须被当前
    // 皮肤包含才会 active，注入骨不在任何皮肤的骨架集合里，会保持零矩阵
    // （表现为兜帽/肩甲/腰带整体不动、贴图全叠在原点）
    data.bones.push(nd);
    // 本工程 spine-player 的 Bone 构造是 (data, skeleton, parent) 三参
    skel.bones.push(new spine.Bone(nd, skel, parentBD ? skel.findBone(parentBD.name) : null));
    boneIdx.set(i, data.bones.length - 1);
    injectedBones++;
  });
  // 4.x 的 Bone.active 默认 false，由 Skeleton.updateCache() 统一激活 ——
  // 该方法只在骨架构造时跑一次，注入骨是构造后手动 new 的，不重跑就永远是
  // 零矩阵（兜帽/肩甲/腰带全叠在原点、不跟随动画）
  if (typeof skel.updateCache === "function") skel.updateCache();

  // 4) 槽位：共存槽记下主骨架下标；独有槽新建后 append（顺序不动，原生皮肤索引不受影响）
  const slotIdx = new Map();            // 伴生槽名 -> 主骨架槽下标
  const commonNames = new Set();        // 两边原生共存的槽（黑化附件走覆盖皮肤）
  const exclude = new Set(cfg.excludeSlots || []);
  const topSlots = new Set(cfg.topSlots || []);
  const inserts = [];                   // { name, anchorIdx } anchor = 伴生槽序里前面最近的共存槽
  comp.slots.forEach(sd => {
    const exist = data.findSlot(sd.name);
    if (exist) { commonNames.add(sd.name); slotIdx.set(sd.name, data.slots.indexOf(exist)); }
  });
  comp.slots.forEach((sd, i) => {
    if (slotIdx.has(sd.name) || exclude.has(sd.name)) return;
    const boneData = data.findBone(sd.boneData.name);
    if (!boneData) throw new Error("companion: 伴生槽 " + sd.name + " 的宿主骨 " + sd.boneData.name + " 在主骨架不存在");
    let anchor = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (slotIdx.has(comp.slots[j].name)) { anchor = slotIdx.get(comp.slots[j].name); break; }
    }
    // 注意：本工程 spine-player 的 SlotData 构造是 (index, name, boneData) 三参
    const nd = new spine.SlotData(data.slots.length, sd.name, boneData);
    nd.color.set(sd.color.r, sd.color.g, sd.color.b, sd.color.a);
    nd.attachmentName = sd.attachmentName;
    nd.blendMode = sd.blendMode;
    slotIdx.set(sd.name, data.slots.length);
    data.slots.push(nd);
    skel.slots.push(new spine.Slot(nd, skel.findBone(boneData.name)));
    inserts.push({ name: sd.name, anchor });
  });

  // 5) 皮肤重建：独有槽附件进 default（槽开关控制）；共有槽的黑化附件按
  //    cfg.overlaySkins 分组建独立覆盖皮肤（DarkBody/DarkTail/DarkEars）。
  const overlaySkins = cfg.overlaySkins || {};
  const overlayBySlot = new Map();
  for (const [sname, slots] of Object.entries(overlaySkins)) {
    for (const s of slots) overlayBySlot.set(s, sname);
  }
  const skinByName = new Map();
  const remapMeshBones = at => {
    if (at && at.bones && at.bones.length) {
      // 权重骨骼格式是交错的：[count, 索引×count, count, ...]，
      // 只有"索引位"换成主骨架下标，count 位原样保留
      const src = at.bones, out = new Array(src.length);
      let p = 0;
      while (p < src.length) {
        const count = src[p];
        out[p] = count;
        for (let k = 1; k <= count; k++) {
          out[p + k] = boneIdx.has(src[p + k]) ? boneIdx.get(src[p + k]) : 0;
        }
        p += count + 1;
      }
      at.bones = out;
    }
  };
  for (const cskin of comp.skins) {
    if ((cfg.skipSkins || []).includes(cskin.name)) continue; // 黑化版的 Face_01 弃用，表情用主骨架原生的
    const skin = new spine.Skin(cskin.name);
    for (const e of cskin.getAttachments()) {
      const sdName = comp.slots[e.slotIndex].name;
      const mi = slotIdx.get(sdName);
      if (mi === undefined) continue;
      const at = e.attachment;
      remapMeshBones(at);
      if (commonNames.has(sdName)) {
        const target = overlayBySlot.get(sdName);
        if (!target) continue; // 没配覆盖皮肤的黑化附件（如黑化脸）直接弃用
        if (!skinByName.has(target)) skinByName.set(target, new spine.Skin(target));
        // 关键：条目名必须用主骨架槽的 setup attachmentName（不带 ALT_ 前缀），
        // 否则 setSlotsToSetupPose 按名查找时永远落空，覆盖皮肤等于白挂
        const mainSlot = data.slots[mi];
        const attName = mainSlot.attachmentName || e.name;
        skinByName.get(target).setAttachment(mi, attName, at);
      } else {
        skin.setAttachment(mi, e.name, at);
      }
    }
    const exist = data.findSkin(cskin.name);
    if (exist) {
      const merged = new spine.Skin(cskin.name);
      merged.addSkin(exist);
      merged.addSkin(skin);
      data.skins[data.skins.indexOf(exist)] = merged;
      if (data.defaultSkin === exist) data.defaultSkin = merged;
    } else if (skin.getAttachments().length) {
      data.skins.push(skin);
    }
  }
  // 覆盖皮肤注册；mirrorSlots 把源槽的黑化条目镜像到镜像槽
  //（原生 r_3/r_4 槽复用 r_1/r_2 的耳环贴图，黑化版同样镜像才不会两副耳环混色）
  const mirror = cfg.mirrorSlots || [];
  for (const [sname, sk] of skinByName) {
    for (const [src, dst] of mirror) {
      const dstSlot = data.findSlot(dst);
      if (!dstSlot) continue;
      const di = data.slots.indexOf(dstSlot);
      for (const e of sk.getAttachments()) {
        const sData = data.slots[e.slotIndex];
        if (sData && sData.name === src) sk.setAttachment(di, e.name, e.attachment);
      }
    }
    const exist = data.findSkin(sname);
    if (exist) {
      const merged = new spine.Skin(sname);
      merged.addSkin(exist);
      merged.addSkin(sk);
      data.skins[data.skins.indexOf(exist)] = merged;
    } else {
      data.skins.push(sk);
    }
  }

  // 6) 动画注入：把伴生的 Idle/Hit 重映射后替换主骨架同名动画。
  //    含约束关键帧的 timeline 一律丢弃（约束索引无法可靠映射，且关键部件不依赖它）。
  let injectedAnims = 0;
  if (cfg.replaceAnimations) {
    const slotMap = new Map();
    comp.slots.forEach((sd, i) => { if (slotIdx.has(sd.name)) slotMap.set(i, slotIdx.get(sd.name)); });
    for (const an of comp.animations) {
      an.timelines = an.timelines.filter(t => typeof t.constraintIndex !== "number");
      for (const t of an.timelines) {
        if (typeof t.boneIndex === "number") t.boneIndex = boneIdx.has(t.boneIndex) ? boneIdx.get(t.boneIndex) : 0;
        if (typeof t.slotIndex === "number") t.slotIndex = slotMap.has(t.slotIndex) ? slotMap.get(t.slotIndex) : 0;
        if (Array.isArray(t.offsets)) {
          for (const o of t.offsets) {
            if (o && typeof o.slotIndex === "number" && slotMap.has(o.slotIndex)) o.slotIndex = slotMap.get(o.slotIndex);
          }
        }
      }
      const idx = data.animations.findIndex(a => a.name === an.name);
      if (idx >= 0) data.animations[idx] = an; else data.animations.push(an);
      injectedAnims++;
    }
  }

  // 7) drawOrder：以伴生（90711）槽序为主干**精确复刻其原生层级** ——
  //    共有槽放主骨架对应槽，注入槽按 90711 原位放置；主骨架独有槽（五官/gg/
  //    裸腿/白耳环）按"主骨架槽序里前面最近共有槽"的锚点插到该槽之后
  //    （与主骨架原生相对层级一致）。之前的"锚点近似"会让兜帽前片被排到
  //    头发/脸之上（红布蒙脸）、臂甲前后片错乱。
  const slotByName = new Map(skel.slots.map(s => [s.data.name, s]));
  const injectedNames = new Set(inserts.map(i => i.name));
  const compIdxByName = new Map(comp.slots.map((s, i) => [s.name, i]));
  const mainAnchor = new Map();   // 90711槽index -> [主骨架独有Slot...]（插在该槽之后）
  let lastAnchor = -1;
  for (const ms of skel.slots) {
    const ci = compIdxByName.get(ms.data.name);
    if (ci !== undefined) { lastAnchor = ci; continue; }      // 共有槽 → 更新锚点
    if (injectedNames.has(ms.data.name)) continue;            // 注入槽由主干覆盖
    if (!mainAnchor.has(lastAnchor)) mainAnchor.set(lastAnchor, []);
    mainAnchor.get(lastAnchor).push(ms);                      // 主骨架独有槽
  }
  const order = [];
  for (let i = 0; i < comp.slots.length; i++) {
    const cName = comp.slots[i].name;
    const s = slotByName.get(cName);                          // 共有槽或注入槽
    if (s) order.push(s);
    if (mainAnchor.has(i)) mainAnchor.get(i).forEach(x => order.push(x));
  }
  skel.drawOrder = order;
  // drawOrder 持久化。关键坑：setToSetupPose 是**就地改写** drawOrder 数组的元素
  //（不是换新数组），而 skel.drawOrder 与 order 是同一引用 —— 直接存 order 会被
  // 第一次 setToSetupPose 污染（表现为排序完全不生效）。必须存干净母本，
  // 且每次恢复都用 slice 副本。
  skel.__injectDrawOrder = order.slice();
  if (!skel.__stspPatched) {
    skel.__stspPatched = true;
    const origSTSP = skel.setToSetupPose.bind(skel);
    skel.setToSetupPose = function () {
      origSTSP();
      if (this.__injectDrawOrder) this.drawOrder = this.__injectDrawOrder.slice();
    };
    // setSlotsToSetupPose 会 arrayCopy 就地把 drawOrder 前段覆盖成槽位定义顺序，
    // applySkin 每次都会显式调它 —— 同样必须拦截，否则排序又被冲掉
    const origSSSP = skel.setSlotsToSetupPose.bind(skel);
    skel.setSlotsToSetupPose = function () {
      origSSSP();
      if (this.__injectDrawOrder) this.drawOrder = this.__injectDrawOrder.slice();
    };
  }
  return { injectedSlots: inserts.length, injectedBones, injectedAnims, skins: comp.skins.length };
}

