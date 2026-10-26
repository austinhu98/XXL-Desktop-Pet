"use strict";
// Original geometric paw icon. No game artwork, fonts or external dependencies.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { buildIco } = require("./build_icon_assets");
const ROOT = path.resolve(__dirname, "..");
const size = 512, rgba = Buffer.alloc(size * size * 4);
const ellipse = (x, y, cx, cy, rx, ry) => ((x-cx)/rx)**2 + ((y-cy)/ry)**2 <= 1;
for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
  const px=(x+.5)/size, py=(y+.5)/size;
  const dx=Math.max(.12-px, 0, px-.88), dy=Math.max(.12-py, 0, py-.88);
  if (dx*dx+dy*dy > .10**2 || px<.02 || px>.98 || py<.02 || py>.98) continue;
  const paw = ellipse(px,py,.50,.63,.23,.17)
    || ellipse(px,py,.28,.39,.075,.10) || ellipse(px,py,.43,.29,.075,.10)
    || ellipse(px,py,.59,.29,.075,.10) || ellipse(px,py,.74,.39,.075,.10);
  const color=paw ? [80,224,202] : [25,34,52];
  const offset=(y*size+x)*4;
  rgba[offset]=color[0]; rgba[offset+1]=color[1]; rgba[offset+2]=color[2]; rgba[offset+3]=255;
}
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1; return n>>>0;});
function chunk(type, data) {
  const label=Buffer.from(type), body=Buffer.concat([label,data]); let crc=0xffffffff;
  for(const byte of body) crc=table[(crc^byte)&255]^(crc>>>8);
  const result=Buffer.alloc(data.length+12); result.writeUInt32BE(data.length);
  body.copy(result,4); result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4); return result;
}
const header=Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
const scan=Buffer.alloc(size*(size*4+1));
for(let y=0;y<size;y++) rgba.copy(scan,y*(size*4+1)+1,y*size*4,(y+1)*size*4);
const png=Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",header),chunk("IDAT",zlib.deflateSync(scan)),chunk("IEND",Buffer.alloc(0))]);
fs.writeFileSync(path.join(ROOT,"build","neutral-icon.png"),png);
for (const [file,sizes] of [["build/icon.ico",[16,24,32,48,64,128,256]], ["assets/icon.ico",[16,24,32,48,64,128,256]], ["assets/tray.ico",[16,20,24,32,40,48]]]) {
  fs.writeFileSync(path.join(ROOT,file),buildIco({width:size,height:size,rgba},sizes));
  console.log("Generated original neutral icon: "+file);
}
