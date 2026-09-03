// 占位图标生成器（零依赖）：深底 + 绿色"可信点"圆，输出 16/48/128 PNG。
// 用 node:zlib 手写最小 PNG（RGBA），正式版换设计图标即可。
//   node scripts/gen-icons.mjs
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [13, 14, 17, 255]; // #0d0e11
const FG = [63, 224, 138, 255]; // #3fe08a

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, c]);
}

function png(size) {
  const w = size,
    h = size;
  const raw = Buffer.alloc(h * (1 + w * 4));
  const cx = (w - 1) / 2,
    cy = (h - 1) / 2,
    r = size * 0.3;
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const col = Math.hypot(x - cx, y - cy) <= r ? FG : BG;
      const o = row + 1 + x * 4;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = col[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("icons", { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`icons/icon${s}.png`, png(s));
console.log("icons 生成完成 → icons/icon{16,48,128}.png");
