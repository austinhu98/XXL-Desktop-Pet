"use strict";
// Data-only role package contract, shared by the packer and ZIP installer.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { loadConfig } = require("./config-loader");
const FORMAT = "spine-desktop-pet-character";
const CONFIG_FILES = ["character.json", "assets.json", "layout.json", "dialogues.json", "persona.json"];
const LIMITS = { zipBytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, files: 4096, manifestBytes: 2 * 1024 * 1024 };
class PackageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new PackageError(code, message); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function validId(id) { return typeof id === "string" && /^[0-9]{4,8}$/.test(id); }
function safeRelative(name) {
  if (typeof name !== "string" || !name || name.length > 240 || /[\\:\x00-\x1f<>"|?*]/.test(name)
    || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === ".."
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part))) {
    fail("UNSAFE_PATH", "资源包包含不安全或不受支持的文件路径");
  }
  return name;
}
function inside(root, relative) {
  safeRelative(relative);
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) fail("UNSAFE_PATH", "资源路径超出安装目录");
  return target;
}
function resourceFiles(assets) {
  const files = new Set();
  function collect(value) {
    if (typeof value === "string" && /^(models|stills)\//.test(value)) files.add("assets/" + safeRelative(value));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  }
  assets.forEach(collect);
  return files;
}
function atlasPages(root, atlasPath) {
  const content = fs.readFileSync(inside(root, atlasPath), "utf8");
  return content.split(/\r?\n/).map(line => line.trim()).filter(line => /\.(png|jpg|jpeg|webp)$/i.test(line))
    .map(name => {
      safeRelative(name);
      return safeRelative(path.posix.join(path.posix.dirname(atlasPath), name));
    });
}
function roleFiles(root, id) {
  if (!validId(id)) fail("INVALID_ID", "角色编号格式错误");
  const dir = path.join(root, "characters", id);
  const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8"));
  if (!Array.isArray(assets)) fail("INVALID_CONFIG", "角色素材配置必须为数组");
  for (const asset of assets) {
    const references = asset.kind === "stills" ? asset.frames : [asset.atlas, asset.skeleton,
      ...(asset.companion ? [asset.companion.skeleton] : [])];
    if (!Array.isArray(references) || !references.length || references.some(file => typeof file !== "string"
      || !/^(models|stills)\//.test(file))) fail("INVALID_CONFIG", "造型资源必须使用包内相对路径：" + asset.id);
    references.forEach(safeRelative);
  }
  const files = resourceFiles(assets);
  for (const asset of assets) if (asset.atlas) {
    const pages = atlasPages(root, "assets/" + safeRelative(asset.atlas));
    if (!pages.length) fail("MISSING_RESOURCE", "图集没有可识别的贴图页面：" + asset.atlas);
    for (const page of pages) files.add(page);
  }
  for (const file of CONFIG_FILES) if (fs.existsSync(path.join(dir, file))) files.add("characters/" + id + "/" + file);
  return [...files].sort();
}
function checkManifest(manifest) {
  if (!manifest || manifest.format !== FORMAT || manifest.version !== 1 || !validId(manifest.characterId)
    || typeof manifest.name !== "string" || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMITS.files) {
    fail("INVALID_MANIFEST", "不是受支持的角色ZIP：缺少有效 manifest.json 或版本不兼容");
  }
  const paths = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string") fail("INVALID_MANIFEST", "资源文件清单格式错误");
    const relative = safeRelative(file.path), key = relative.toLowerCase();
    const config = relative.startsWith("characters/" + manifest.characterId + "/")
      && CONFIG_FILES.includes(relative.split("/").slice(2).join("/"));
    const resource = /^assets\/(models|stills)\/.+\.(skel|atlas|png|jpg|jpeg|webp|json|wav|mp3|ogg)$/i.test(relative);
    if ((!config && !resource) || paths.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes
      || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) fail("INVALID_MANIFEST", "清单包含重复路径、非法文件或不合理的大小/校验值");
    paths.add(key); total += file.size;
  }
  if (total > LIMITS.totalBytes) fail("PACKAGE_TOO_LARGE", "资源包解压后超过大小限制");
  return manifest;
}
function validateStaged(root, manifest) {
  checkManifest(manifest);
  const config = loadConfig({ root, onDiagnostic() {} });
  if (config.characters.length !== 1 || config.characters[0].id !== manifest.characterId || config.diagnostics.length) {
    fail("INVALID_CONFIG", "角色配置校验失败：" + (config.diagnostics.map(row => row.message).join("；") || "角色编号不一致"));
  }
  const ids = new Set(config.assets.map(asset => asset.id));
  const character = config.characters[0];
  if (![...character.sfw || [], ...character.r18 || []].some(id => !config.assets.find(asset => asset.id === id)?.devOnly)) {
    fail("INVALID_CONFIG", "资源包没有可直接显示的角色造型");
  }
  if (character.name !== manifest.name) fail("INVALID_MANIFEST", "清单名称与角色配置不一致");
  const roleDir = path.join(root, "characters", manifest.characterId);
  if (fs.existsSync(path.join(roleDir, "persona.json"))) {
    const persona = JSON.parse(fs.readFileSync(path.join(roleDir, "persona.json"), "utf8"));
    if (!persona || String(persona.id) !== manifest.characterId || !persona.name || !persona.identity) fail("INVALID_CONFIG", "角色人设编号或基础字段不正确");
  }
  if (fs.existsSync(path.join(roleDir, "dialogues.json"))) {
    const dialogues = JSON.parse(fs.readFileSync(path.join(roleDir, "dialogues.json"), "utf8"));
    if (!dialogues || !Array.isArray(dialogues.lines)) fail("INVALID_CONFIG", "角色台词配置格式错误");
  }
  for (const id of Object.keys(character.models || {})) if (!ids.has(id)) fail("MISSING_RESOURCE", "角色规则引用了包外造型：" + id);
  if (character.secret) for (const key of ["from", "to", "back"]) {
    if (character.secret[key] && !ids.has(character.secret[key])) fail("MISSING_RESOURCE", "CG规则引用了包外造型：" + character.secret[key]);
  }
  for (const asset of config.assets) if (asset.kind !== "stills") {
    if (!asset.animations.length || asset.animations.some(name => typeof name !== "string" || !name)) fail("INVALID_CONFIG", "造型缺少有效动画列表：" + asset.id);
    if (!config.layoutProfiles[asset.id]) fail("MISSING_RESOURCE", "缺少造型布局档案：" + asset.id);
  }
  const expected = roleFiles(root, manifest.characterId), listed = new Set(manifest.files.map(file => file.path));
  for (const file of expected) if (!listed.has(file) || !fs.existsSync(inside(root, file))) fail("MISSING_RESOURCE", "资源包缺少运行文件：" + file);
  if (listed.size !== expected.length) fail("UNEXPECTED_FILE", "资源包包含未声明的运行依赖或多余文件");
  return config;
}
module.exports = { FORMAT, CONFIG_FILES, LIMITS, PackageError, fail, sha256, validId, safeRelative, inside, roleFiles, checkManifest, validateStaged };
