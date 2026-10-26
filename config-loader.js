// 角色配置加载器：characters/<角色ID>/ 一个目录 = 一个已装载的角色。
//
// 目录结构（每个角色独立，卸载 = 删掉整个目录）：
//   characters/10423/
//     character.json   角色本身：名称、sfw/r18 造型列表、models 规则、彩蛋
//     assets.json      这个角色的全部造型入口（atlas / skel / 表情 / 场景序列）
//     layout.json      这个角色的取景档案 { profiles: { <造型id>: {...} } }
//     dialogues.json   这个角色的点击台词（可缺省 → 该角色不播台词）
//
// 素材仍然是共用的：assets/models/<造型id>/ 不动，配置里存相对路径。
// 只有 character.json 存在才算"已装载"，缺文件或解析失败会被跳过，
// 不会因为一个坏目录让整个桌宠起不来。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CHARS_DIR = path.join(ROOT, "characters");
const META_FILE = path.join(ROOT, "assets", "dialogue-meta.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function listCharacterIds(options = {}) {
  const charsDir = options.root ? path.join(options.root, "characters") : CHARS_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(charsDir, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(charsDir, name, "character.json")))
    .sort();
}

function loadConfig(options = {}) {
  const root = options.root || ROOT;
  const assets = [];
  const characters = [];
  const layoutProfiles = {};
  const roles = {};
  const diagnostics = [];
  const roleIds = new Set();
  const assetById = new Map();
  const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function warn(directory, code, message) {
    diagnostics.push({ directory, code, message });
    if (options.onDiagnostic) options.onDiagnostic(diagnostics[diagnostics.length - 1]);
    else console.warn("[pet]", directory, code + ":", message);
  }

  for (const dirName of listCharacterIds(options)) {
    const dir = path.join(root, "characters", dirName);
    const character = readJson(path.join(dir, "character.json"), null);
    if (!isObject(character) || !["string", "number"].includes(typeof character.id)
      || !String(character.id).trim() || typeof character.name !== "string") {
      warn(dirName, "invalid-character", "跳过无法解析或缺少编号/名称的角色");
      continue;
    }
    const roleId = String(character.id);
    if (roleIds.has(roleId)) {
      warn(dirName, "duplicate-character", "角色编号重复，保留先前已装载角色");
      continue;
    }
    const localAssets = readJson(path.join(dir, "assets.json"), null);
    if (!Array.isArray(localAssets) || !localAssets.length || localAssets.some(asset => !isObject(asset)
      || typeof asset.id !== "string" || !asset.id || ["__proto__", "constructor", "prototype"].includes(asset.id)
      || (asset.kind === "stills" ? !Array.isArray(asset.frames) || !asset.frames.length
        : typeof asset.atlas !== "string" || typeof asset.skeleton !== "string" || !Array.isArray(asset.animations)))) {
      warn(dirName, "invalid-assets", "素材列表无效，仅跳过该角色");
      continue;
    }
    const localIds = new Set(localAssets.map(asset => asset.id));
    const menuIds = [character.sfw || [], character.r18 || []];
    if (localIds.size !== localAssets.length || menuIds.some(list => !Array.isArray(list)
      || list.some(id => !localIds.has(id)))) {
      warn(dirName, "invalid-model-references", "造型引用必须由本角色素材列表提供");
      continue;
    }
    if (localAssets.some(asset => assetById.has(asset.id) && !equal(assetById.get(asset.id), asset))) {
      warn(dirName, "conflicting-asset", "造型编号与已有角色冲突，拒绝覆盖已有素材");
      continue;
    }
    const layout = readJson(path.join(dir, "layout.json"), null);
    const localProfiles = {};
    if (isObject(layout) && isObject(layout.profiles)) {
      for (const [id, profile] of Object.entries(layout.profiles)) {
        if (!localIds.has(id) || !isObject(profile)) {
          warn(dirName, "foreign-or-invalid-layout", "忽略非本角色造型或无效布局: " + id);
          continue;
        }
        localProfiles[id] = profile;
      }
    }
    if (Object.entries(localProfiles).some(([id, profile]) => Object.prototype.hasOwnProperty.call(layoutProfiles, id)
      && !equal(layoutProfiles[id], profile))) {
      warn(dirName, "conflicting-layout", "布局编号与已有角色冲突，拒绝覆盖已有档案");
      continue;
    }
    // Commit only after validating this package. Identical explicitly shared
    // assets are deduplicated; conflicting later packages cannot alter earlier ones.
    characters.push(Object.assign({}, character, { id: roleId }));
    roleIds.add(roleId);
    for (const asset of localAssets) if (!assetById.has(asset.id)) {
      assetById.set(asset.id, asset);
      assets.push(asset);
    }
    Object.assign(layoutProfiles, localProfiles);
    const role = readJson(path.join(dir, "dialogues.json"), null);
    if (isObject(role) && Array.isArray(role.lines)) roles[roleId] = role;
  }

  // 下拉顺序：character.json 里写 order 的按 order 排，没写的排在后面按 id
  characters.sort((a, b) => {
    const oa = Number.isFinite(a.order) ? a.order : 9999;
    const ob = Number.isFinite(b.order) ? b.order : 9999;
    return oa === ob ? String(a.id).localeCompare(String(b.id)) : oa - ob;
  });

  // 公共台词元数据属于程序文件（assets/dialogue-meta.json），不随角色数据目录走：
  // 打包版角色数据在可写目录里，元数据仍在安装目录，所以允许显式指定。
  const metaPath = options.metaFile
    || (options.root ? path.join(root, "assets", "dialogue-meta.json") : META_FILE);
  const meta = readJson(metaPath, {});
  return {
    assets,
    characters,
    layoutProfiles,
    dialogues: Object.assign({}, meta, { roles }),
    diagnostics,
    characterIds: characters.map(item => String(item.id))
  };
}

module.exports = { loadConfig, listCharacterIds, CHARS_DIR };
