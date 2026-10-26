"use strict";
// 由一张源图（.ico / .png）生成 Windows 全套图标：
//   build/icon.ico   —— EXE / 安装包 / 任务栏（多尺寸：16 24 32 48 64 128 256）
//   assets/icon.ico  —— 窗口图标（BrowserWindow icon）
//   assets/tray.ico  —— 托盘图标（16/20/24/32，托盘只需要小尺寸）
//
// 只为"换图标"服务：用法 node tools/build_icon_assets.js <源图路径>
// 不生成/美化美术素材，完全按源图重采样，避免擅自改设计。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");

function decodeIco(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error("不是有效的 ICO 文件");
  const count = buffer.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const width = buffer[off] || 256;
    const height = buffer[off + 1] || 256;
    const size = buffer.readUInt32LE(off + 8);
    const dataOff = buffer.readUInt32LE(off + 12);
    if (!best || width * height > best.width * best.height) {
      best = { width, height, data: buffer.slice(dataOff, dataOff + size) };
    }
  }
  if (!best) throw new Error("ICO 里没有图像");
  const isPng = best.data.slice(0, 4).toString("hex") === "89504e47";
  if (isPng) return decodePng(best.data);
  return decodeDib(best.data, best.width, best.height);
}

function decodeDib(dib, width, height) {
  const headerSize = dib.readUInt32LE(0);
  const w = dib.readInt32LE(4);
  const h = Math.abs(dib.readInt32LE(8)) / 2;
  const bpp = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  if (compression !== 0) throw new Error("不支持压缩的 ICO 位图");
  const rowLength = Math.floor((bpp * w + 31) / 32) * 4;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = headerSize + (h - 1 - y) * rowLength;
    for (let x = 0; x < w; x++) {
      const s = src + x * (bpp / 8);
      const d = (y * w + x) * 4;
      if (bpp === 32) {
        rgba[d] = dib[s + 2]; rgba[d + 1] = dib[s + 1]; rgba[d + 2] = dib[s]; rgba[d + 3] = dib[s + 3];
      } else if (bpp === 24) {
        rgba[d] = dib[s + 2]; rgba[d + 1] = dib[s + 1]; rgba[d + 2] = dib[s]; rgba[d + 3] = 255;
      } else {
        throw new Error("暂不支持 " + bpp + " 位 ICO");
      }
    }
  }
  return { width: w, height: h, rgba };
}

// 最小 PNG 解码：只支持 8 位 RGB/RGBA、非隔行（图标源图足够）
function decodePng(buffer) {
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buffer.length) {
    const length = buffer.readUInt32BE(off);
    const type = buffer.slice(off + 4, off + 8).toString("ascii");
    const data = buffer.slice(off + 8, off + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error("PNG 仅支持 8 位非隔行 RGBA/RGB");
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = cur[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = value & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = out[i * channels];
    rgba[i * 4 + 1] = out[i * channels + 1];
    rgba[i * 4 + 2] = out[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? out[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

// 面积平均下采样 / 双线性上采样（预乘后再插值，避免边缘发黑）
function resize(source, targetSize) {
  const { width: sw, height: sh, rgba: src } = source;
  const dst = Buffer.alloc(targetSize * targetSize * 4);
  const scaleX = sw / targetSize, scaleY = sh / targetSize;
  const sample = (x, y) => {
    const sx = Math.min(sw - 1, Math.max(0, x)), sy = Math.min(sh - 1, Math.max(0, y));
    const i = (sy * sw + sx) * 4;
    const a = src[i + 3] / 255;
    return [src[i] * a, src[i + 1] * a, src[i + 2] * a, a];
  };
  const down = targetSize < sw;
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      if (down) {
        const x0 = Math.floor(x * scaleX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
        const y0 = Math.floor(y * scaleY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
        let n = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
          const p = sample(sx, sy); r += p[0]; g += p[1]; b += p[2]; a += p[3]; n++;
        }
        r /= n; g /= n; b /= n; a /= n;
      } else {
        const fx = Math.min(sw - 1.001, (x + 0.5) * scaleX - 0.5);
        const fy = Math.min(sh - 1.001, (y + 0.5) * scaleY - 0.5);
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const wx = fx - x0, wy = fy - y0;
        const p00 = sample(x0, y0), p10 = sample(x0 + 1, y0), p01 = sample(x0, y0 + 1), p11 = sample(x0 + 1, y0 + 1);
        for (let k = 0; k < 4; k++) {
          const top = p00[k] * (1 - wx) + p10[k] * wx;
          const bottom = p01[k] * (1 - wx) + p11[k] * wx;
          const value = top * (1 - wy) + bottom * wy;
          if (k === 0) r = value; else if (k === 1) g = value; else if (k === 2) b = value; else a = value;
        }
      }
      const d = (y * targetSize + x) * 4;
      if (a > 0) {
        dst[d] = Math.min(255, Math.round(r / a));
        dst[d + 1] = Math.min(255, Math.round(g / a));
        dst[d + 2] = Math.min(255, Math.round(b / a));
      }
      dst[d + 3] = Math.min(255, Math.round(a * 255));
    }
  }
  return { width: targetSize, height: targetSize, rgba: dst };
}

// 32 位 BMP 形式的 ICO 条目（兼容性最好，不依赖 PNG 支持）
function encodeDibEntry(image) {
  const { width, height, rgba } = image;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const rowLength = width * 4;
  const pixels = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = y * rowLength;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4, d = dstRow + x * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  }
  // AND 掩码：32 位图标可全 0（用 alpha 通道），但部分老组件仍读，补上更稳
  const maskRowLength = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskRowLength * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[((height - 1 - y) * width + x) * 4 + 3];
      if (alpha === 0) mask[y * maskRowLength + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(source, sizes) {
  const images = sizes.map(size => encodeDibEntry(resize(source, size)));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  images.forEach((data, index) => {
    const size = sizes[index];
    const entry = 6 + index * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images]);
}

function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("用法: node tools/build_icon_assets.js <源图 .ico/.png>");
    process.exit(1);
  }
  const buffer = fs.readFileSync(path.resolve(sourcePath));
  const isPng = buffer.slice(0, 4).toString("hex") === "89504e47";
  const source = isPng ? decodePng(buffer) : decodeIco(buffer);
  console.log(`源图: ${sourcePath} ${source.width}x${source.height}`);

  const outputs = [
    ["build/icon.ico", [16, 24, 32, 48, 64, 128, 256]],
    ["assets/icon.ico", [16, 24, 32, 48, 64, 128, 256]],
    ["assets/tray.ico", [16, 20, 24, 32, 40, 48]]
  ];
  for (const [relative, sizes] of outputs) {
    const file = path.join(ROOT, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildIco(source, sizes));
    console.log(`写入 ${relative} — ${sizes.join("/")} (${fs.statSync(file).size} 字节)`);
  }
  console.log("同时导出 preview(256) 到 build/icon_preview_256.ico 便于核对");
  fs.writeFileSync(path.join(ROOT, "build", "icon_preview_256.ico"), buildIco(source, [256]));
}

if (require.main === module) main();
module.exports = { decodeIco, decodePng, resize, buildIco };
