import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * 占位图标生成脚本（T2.12，零第三方依赖）：
 * - 手写最小 PNG 编码器（RGBA + zlib），不引入图像库、不从网络下载素材；
 * - 图形与 index.html 现有 favicon 同风格：靛蓝圆角方块 + 白色学士帽，
 *   与正式图标（待用户提供）区分：属自绘占位，无版权问题；
 * - 产物（apps/web/public/icons/）：
 *   icon-192/512.png（purpose=any，圆角透明底）、
 *   maskable-192/512.png（全出血背景 + 80% 安全区内容）、
 *   apple-touch-icon.png（180，iOS 添加到主屏幕用，方形不透明底）。
 * 重新生成：node apps/web/scripts/generate-icons.mjs（换正式图标时改本脚本或直接替换文件）。
 */

// ---------- 最小 PNG 编码器（color type 6 = RGBA，8bit） ----------

/** CRC32（PNG chunk 校验用），标准查表实现 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度(4) + 类型(4) + 数据 + CRC32(4) */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * 编码 RGBA 位图为 PNG。
 * @param size 画布边长（正方形）
 * @param pixel (x, y)（0..1 归一化坐标）→ [r, g, b, a]
 */
function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1)); // 每行前置过滤字节 0
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 图形绘制（坐标全部归一化到 0..1） ----------

const BG = [79, 70, 229, 255]; // 靛蓝 #4f46e5（与 favicon / theme_color 一致）
const WHITE = [255, 255, 255, 255];
const BASE = [199, 210, 254, 255]; // 浅靛 #c7d2fe（帽沿）

/** 点是否在压扁菱形（学士帽顶）内：|dx|/hw + |dy|/hh <= 1 */
function inDiamond(x, y, cx, cy, hw, hh) {
  return Math.abs(x - cx) / hw + Math.abs(y - cy) / hh <= 1;
}

/** 点是否在梯形（帽的底座）内：y∈[y0,y1] 且 |x-0.5| <= 按线性插值的半宽 */
function inTrapezoid(x, y, y0, y1, halfTop, halfBottom) {
  if (y < y0 || y > y1) return false;
  const t = (y - y0) / (y1 - y0);
  return Math.abs(x - 0.5) <= halfTop + (halfBottom - halfTop) * t;
}

/** 点是否在圆角方形内（背景/any 图标透明圆角用） */
function inRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, 0, x - (1 - radius));
  const dy = Math.max(radius - y, 0, y - (1 - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * 计算一点的最终颜色（4x4 超采样抗锯齿）。
 * @param x,y 归一化像素中心
 * @param size 图标边长（像素，超采样步长换算用）
 * @param contentScale 内容缩放（maskable 用 0.8：内容收进 80% 安全区）
 * @param rounded 是否圆角透明底（any 图标）；false = 全出血方形（maskable / apple-touch）
 */
function samplePixel(x, y, size, contentScale, rounded, samples = 4) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + ((sx + 0.5) / samples - 0.5) / size;
      const py = y + ((sy + 0.5) / samples - 0.5) / size;
      const bg = rounded ? inRoundedSquare(px, py, 0.22) : true;
      if (!bg) continue; // 透明
      // 内容坐标：缩放到安全区后再判断
      const cx = 0.5 + (px - 0.5) / contentScale;
      const cy = 0.5 + (py - 0.5) / contentScale;
      let color = BG;
      if (inTrapezoid(cx, cy, 0.47, 0.66, 0.17, 0.13)) color = BASE;
      if (inDiamond(cx, cy, 0.5, 0.42, 0.32, 0.16)) color = WHITE;
      r += color[0];
      g += color[1];
      b += color[2];
      a += 255;
    }
  }
  const total = samples * samples;
  return [
    Math.round(r / total),
    Math.round(g / total),
    Math.round(b / total),
    Math.round(a / total),
  ];
}

// ---------- 产物清单与写盘 ----------

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "icons",
);
mkdirSync(outDir, { recursive: true });

const outputs = [
  { file: "icon-192.png", size: 192, contentScale: 1, rounded: true },
  { file: "icon-512.png", size: 512, contentScale: 1, rounded: true },
  { file: "maskable-192.png", size: 192, contentScale: 0.8, rounded: false },
  { file: "maskable-512.png", size: 512, contentScale: 0.8, rounded: false },
  { file: "apple-touch-icon.png", size: 180, contentScale: 1, rounded: false },
];

for (const { file, size, contentScale, rounded } of outputs) {
  const png = encodePng(size, (x, y) =>
    samplePixel(x, y, size, contentScale, rounded),
  );
  writeFileSync(join(outDir, file), png);
  console.log(`已生成 ${file}（${size}x${size}，${png.length} 字节）`);
}
