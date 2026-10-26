"use strict";
const fs = require("fs"), fsp = fs.promises, path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const { Transform, Writable } = require("stream"), { pipeline } = require("stream/promises");
const yauzl = require("yauzl");
const { loadConfig } = require("./config-loader");
const P = require("./character-package");
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(bytes, previous = 0) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(bytes, previous);
  let crc = previous ^ -1;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ -1) >>> 0;
}
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function safeParents(root, relative, create = false) {
  P.inside(root, relative);
  let cursor = root;
  for (const component of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = await fsp.lstat(cursor); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return;
      await fsp.mkdir(cursor).catch(error => { if (error.code !== "EEXIST") throw error; });
      stat = await fsp.lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) P.fail("UNSAFE_DESTINATION", "安装路径包含链接或非目录，已停止安装");
  }
}
async function openZip(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > P.LIMITS.zipBytes) P.fail("INVALID_ZIP", "请选择有效且不超过512MB的ZIP文件");
  const zip = await new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true
  }, (error, zip) => error ? reject(error) : resolve(zip)));
  try {
    const entries = await new Promise((resolve, reject) => {
      const entries = [], names = new Set(); let total = 0;
      zip.on("error", reject);
      zip.on("entry", entry => {
        try {
          const directory = entry.fileName.endsWith("/");
          P.safeRelative(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const key = entry.fileName.toLowerCase();
          const mode = entry.externalFileAttributes >>> 16 & 0xf000;
          if (names.has(key) || (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)
            || mode && mode !== 0x8000 && mode !== 0x4000) P.fail("INVALID_ZIP", "ZIP包含重复文件、链接、加密或不支持的压缩格式");
          names.add(key); total += entry.uncompressedSize;
          if (names.size > P.LIMITS.files + 32 || entry.uncompressedSize > P.LIMITS.fileBytes || total > P.LIMITS.totalBytes) {
            P.fail("PACKAGE_TOO_LARGE", "ZIP文件数量或解压大小超过限制");
          }
          if (!directory) entries.push(entry);
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.on("end", () => resolve(entries)); zip.readEntry();
    });
    return { zip, entries };
  } catch (error) { zip.close(); throw error; }
}
async function readEntry(zip, entry, output) {
  const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, input) => error ? reject(error) : resolve(input)));
  let size = 0, crc = 0; const hash = crypto.createHash("sha256"), chunks = [];
  const counter = new Transform({ transform(bytes, _encoding, callback) {
    size += bytes.length;
    if (size > entry.uncompressedSize || size > P.LIMITS.fileBytes) return callback(new P.PackageError("PACKAGE_TOO_LARGE", "ZIP解压大小与声明不符"));
    crc = crc32(bytes, crc); hash.update(bytes); callback(null, bytes);
  } });
  if (output) await pipeline(stream, counter, fs.createWriteStream(output, { flags: "wx" }));
  else await pipeline(stream, counter, new Writable({ write(bytes, _encoding, done) { chunks.push(bytes); done(); } }));
  if (size !== entry.uncompressedSize || crc !== (entry.crc32 >>> 0)) P.fail("CORRUPT_ZIP", "ZIP校验失败，文件可能已损坏：" + entry.fileName);
  return { size, sha256: hash.digest("hex"), bytes: output ? null : Buffer.concat(chunks) };
}
function createCharacterImporter(options = {}) {
  const root = path.resolve(options.root || __dirname);
  const inboxDir = path.join(root, "角色导入");
  const workDir = path.join(root, "work", "character-import"), stages = path.join(workDir, "staging");
  const lockPath = path.join(workDir, "install.lock");
  let queue = Promise.resolve(), watcher = null, poll = null, debounce = null, stopped = true;
  const pending = new Set(), seen = new Map();
  const scanTasks = new Set();
  const history = [];
  function status() { return { directory: inboxDir, results: history.slice(-30) }; }
  async function acquireLock() {
    await safeParents(root, "work/character-import/install.lock", true);
    try {
      const handle = await fsp.open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return handle; }
      catch (error) { await handle.close(); await fsp.unlink(lockPath).catch(() => {}); throw error; }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await fsp.readFile(lockPath, "utf8"));
        if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw Error("invalid lock");
        try { process.kill(lock.pid, 0); } catch (error) {
          if (error.code === "ESRCH") { await fsp.unlink(lockPath); return acquireLock(); }
        }
      } catch { /* Leave a recent/unknown lock untouched. */ }
      P.fail("BUSY", "另一个桌宠正在导入角色，请稍后重试");
    }
  }
  async function install(file) {
    let zip, stage, lock, committed = false; const created = [];
    try {
      if (path.extname(file).toLowerCase() !== ".zip") P.fail("INVALID_ZIP", "只能导入ZIP资源包");
      const opened = await openZip(file); zip = opened.zip;
      const manifestEntry = opened.entries.find(entry => entry.fileName === "manifest.json");
      if (!manifestEntry || manifestEntry.uncompressedSize > P.LIMITS.manifestBytes) P.fail("INVALID_MANIFEST", "角色ZIP缺少有效的 manifest.json");
      let manifest;
      try { manifest = JSON.parse((await readEntry(zip, manifestEntry)).bytes.toString("utf8")); }
      catch (error) { if (error instanceof P.PackageError) throw error; P.fail("INVALID_MANIFEST", "manifest.json 格式错误"); }
      P.checkManifest(manifest);
      lock = await acquireLock();
      const installed = loadConfig({ root, onDiagnostic() {} });
      const finalRole = path.join(root, "characters", manifest.characterId);
      if (installed.characterIds.includes(manifest.characterId)) {
        return { ok: false, code: "DUPLICATE", duplicate: true, characterId: manifest.characterId, name: manifest.name,
          message: "角色已安装，已跳过，未覆盖原有文件：" + manifest.name };
      }
      if (fs.existsSync(finalRole)) P.fail("DIRECTORY_EXISTS", "角色目录已存在但未正确装载。为保护现有文件已停止安装，请先将该目录移出备份后再导入");
      const listed = new Map(manifest.files.map(row => [row.path, row]));
      if (opened.entries.length !== listed.size + 1 || opened.entries.some(entry => entry.fileName !== "manifest.json" && !listed.has(entry.fileName))) {
        P.fail("INVALID_MANIFEST", "ZIP文件与资源清单不一致，可能缺少资源或包含多余文件");
      }
      await safeParents(root, "work/character-import/staging/.placeholder", true);
      stage = await fsp.mkdtemp(path.join(stages, "pkg-"));
      for (const entry of opened.entries) {
        if (entry === manifestEntry) continue;
        const expected = listed.get(entry.fileName);
        if (expected.size !== entry.uncompressedSize) P.fail("CORRUPT_ZIP", "资源大小校验失败：" + entry.fileName);
        const target = P.inside(stage, entry.fileName);
        await safeParents(stage, entry.fileName, true);
        const actual = await readEntry(zip, entry, target);
        if (actual.sha256 !== expected.sha256) P.fail("CORRUPT_ZIP", "资源SHA-256校验失败：" + entry.fileName);
      }
      for (const item of manifest.files.filter(row => row.path.startsWith("characters/"))) {
        try { JSON.parse(await fsp.readFile(P.inside(stage, item.path), "utf8")); }
        catch { P.fail("INVALID_CONFIG", "角色JSON格式错误：" + item.path); }
      }
      const config = P.validateStaged(stage, manifest);
      const existingIds = new Set(installed.assets.map(asset => asset.id));
      if (config.assets.some(asset => existingIds.has(asset.id))) P.fail("ASSET_CONFLICT", "造型编号与已有角色冲突，安装已取消");
      const resources = manifest.files.filter(row => row.path.startsWith("assets/"));
      for (const item of resources) {
        await safeParents(root, item.path);
        const target = P.inside(root, item.path);
        if (fs.existsSync(target)) {
          const stat = await fsp.lstat(target);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== item.size || await digest(target) !== item.sha256) {
            P.fail("RESOURCE_CONFLICT", "同名资源与已有文件不同，未覆盖：" + item.path);
          }
        }
      }
      for (const item of resources) {
        const target = P.inside(root, item.path);
        if (fs.existsSync(target)) continue;
        await safeParents(root, item.path, true);
        const handle = await fsp.open(target, "wx"); created.push(target);
        await pipeline(fs.createReadStream(P.inside(stage, item.path)), handle.createWriteStream());
      }
      await safeParents(root, "characters/" + manifest.characterId + "/character.json", true);
      // safeParents created the final empty directory; remove only that empty
      // reservation, then rename the complete validated role atomically.
      await fsp.rmdir(finalRole);
      if (options.beforeCommit) await options.beforeCommit({ manifest, root });
      await fsp.rename(path.join(stage, "characters", manifest.characterId), finalRole); committed = true;
      return { ok: true, code: "INSTALLED", characterId: manifest.characterId, name: manifest.name, message: "已导入角色：" + manifest.name };
    } catch (error) {
      if (!committed) for (const file of created.reverse()) await fsp.unlink(file).catch(() => {});
      return { ok: false, code: error.code || "INSTALL_FAILED", message: error instanceof P.PackageError ? error.message
        : "ZIP损坏、资源缺失或安装目录不可写：" + error.message };
    } finally {
      if (zip) zip.close();
      if (stage && stage.startsWith(stages + path.sep) && path.basename(stage).startsWith("pkg-")) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (lock) { await lock.close().catch(() => {}); await fsp.unlink(lockPath).catch(() => {}); }
    }
  }
  function importFile(file, source = "manual") {
    const job = queue.then(() => install(path.resolve(file))).then(async result => {
      result = { ...result, source, file: path.basename(file), at: new Date().toISOString() };
      history.push(result); if (history.length > 30) history.shift();
      if (options.onResult) { try { await options.onResult(result); } catch { /* committed install remains successful */ } }
      return result;
    });
    queue = job.catch(() => {}); return job;
  }
  async function scanInbox() {
    await safeParents(root, "角色导入/.placeholder", true);
    const files = await fsp.readdir(inboxDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of files) {
      if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
      const file = path.join(inboxDir, entry.name);
      const stat = await fsp.stat(file).catch(() => null); if (!stat) continue;
      const signature = stat.size + ":" + stat.mtimeMs;
      if (seen.get(file) === signature || pending.has(file)) continue;
      pending.add(file);
      const task = (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, options.stableMs == null ? 1000 : options.stableMs));
          const current = await fsp.stat(file).catch(() => null);
          if (!current || current.size + ":" + current.mtimeMs !== signature) return;
          const result = await importFile(file, "directory");
          if (result.code !== "BUSY") seen.set(file, signature);
        } finally { pending.delete(file); }
      })();
      jobs.push(task); scanTasks.add(task);
      task.finally(() => scanTasks.delete(task)).catch(() => {});
    }
    await Promise.all(jobs); return status();
  }
  async function start() {
    if (!stopped) return; stopped = false;
    await safeParents(root, "角色导入/.placeholder", true);
    const run = () => { if (!stopped) scanInbox().catch(error => options.onError && options.onError(error)); };
    watcher = fs.watch(inboxDir, () => { clearTimeout(debounce); debounce = setTimeout(run, 750); });
    watcher.on("error", error => options.onError && options.onError(error));
    poll = setInterval(run, 15000); poll.unref?.(); run();
  }
  function stop() { stopped = true; watcher?.close(); watcher = null; clearInterval(poll); clearTimeout(debounce); }
  return { importFile, scanInbox, start, stop, status, inboxDir, async flush() {
    while (scanTasks.size) await Promise.allSettled([...scanTasks]);
    await queue;
  } };
}
module.exports = { createCharacterImporter, openZip, readEntry, digest };
