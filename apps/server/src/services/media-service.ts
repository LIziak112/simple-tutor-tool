import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MediaUploadResult } from "@tutor/contract";
import { mediaUploadResultSchema } from "@tutor/contract";
import { HttpError } from "../lib/http-error";

/**
 * MediaService（媒体管线第二单）——::image 图片的内容寻址存储与伺服读取。
 *
 * 存储：DATA_DIR/blobs/media/<sha256>.<扩展名>（与笔迹的 blobs/ink/ 平级）：
 * - 文件名即内容哈希（小写 sha256 hex）：同名必同内容，天然幂等去重；
 * - 类型只认魔数（不信任上传方 MIME/文件名扩展）：PNG/JPEG/GIF/WEBP 白名单
 *   之外一律 415 UNSUPPORTED_MEDIA_TYPE——svg 等文本/可执行内容拒之门外；
 * - 扩展名按检测结果规范化（JPEG 统一存 jpg），返回的 src 形如
 *   blobs/media/<hash>.<ext>，与契约 MEDIA_SRC_PATTERN（media-api.ts）一致；
 * - 上传上限 5MB（MEDIA_MAX_UPLOAD_BYTES），超限 413 MEDIA_TOO_LARGE
 *   （app.ts 另有 6MB content-length 粗防线，此处按实际字节数兜底 chunked）；
 * - 写入走 <名>.tmp + rename 原子替换（写一半崩溃不留半截文件，同 ink-service）；
 *   文件已存在则幂等跳过写入（内容寻址同名即同内容，重复上传零成本）。
 *
 * 伺服：URL 是 /blobs/media/<hash>.<ext>——契约 src（blobs/media/<hash>.<ext>）
 * 前加 / 即根相对伺服 URL，一一对应。app.ts 的 /blobs/* 路由按
 * MEDIA_BLOB_URL_TAIL_PATTERN 剥掉字面 media/ 前缀段得到单段文件名，交给
 * readMediaBlob 读回字节与 Content-Type。两层正则均与契约同源：多段路径、
 * `..` 穿越、非白名单扩展名一律按未命中处理，blobs/ink/ 等其他子目录经
 * /blobs/* 天然不可达（测试锁定）。
 */

/** 图片上传上限：5MB（契约口径见 media-api.ts 的 MEDIA_TOO_LARGE 说明） */
export const MEDIA_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * 单段文件名的核心形态（无锚点）：与契约 MEDIA_SRC_PATTERN 的文件名段一致
 * （64 位小写 hex + 白名单扩展名）。文件名与 URL 尾段两个正则都由它拼装
 * （注意 RegExp.source 含锚点，不能从成品正则反解，故以字符串为源）。
 */
const MEDIA_BLOB_FILENAME_SOURCE = "[0-9a-f]{64}\\.(png|jpe?g|webp|gif)";

/**
 * 伺服文件名的单段形态（readMediaBlob 只接受它）。
 */
export const MEDIA_BLOB_FILENAME_PATTERN = new RegExp(
  `^${MEDIA_BLOB_FILENAME_SOURCE}$`,
);

/**
 * /blobs/* 伺服 URL 去掉 /blobs/ 前缀后的合法尾段：字面 media/ 段 + 单段文件名
 * （捕获组 1 即文件名，与 MEDIA_BLOB_FILENAME_PATTERN 同源拼装）。
 * 不变量：契约 src 前加 / 即根相对伺服 URL，一一对应——前端把 ::image 的 src
 * 归一化为根相对路径即可直接请求。media 是唯一合法前缀段：缺它（/blobs/<名>）、
 * 别的子目录（ink/ 等）、`..` 穿越形态一律不匹配。
 */
export const MEDIA_BLOB_URL_TAIL_PATTERN = new RegExp(
  `^media/(${MEDIA_BLOB_FILENAME_SOURCE})$`,
);

// ---------- ::image 图片引用提取（导出打包与导入存在性核对共用） ----------

/**
 * 从 markdown 文本提取 ::image 引用的图片 src（严格契约形态）。
 * 落点说明（自 export-service 抽取为共享函数）：既供学习包导出扫「哪些图片
 * 要打进 zip」，也供导入链路核对「引用的文件是否真的上传过」——两处口径
 * 必须同源（同一份正则），故收敛在本模块（media 域）单点维护。
 * 用单一正则扫指令行的 src 值、不引入 md-dsl 解析器依赖——调用方只需要
 * 「一份 src 清单」，完整指令语义（未知属性降级等）由解析/渲染层负责；
 * 正则按契约 MEDIA_SRC_PATTERN 的严格形态匹配（64 位小写 hex + 白名单扩展名），
 * 旧式 blobs/fig-1.png 等无内容寻址文件可寻的引用静默跳过。
 */
export function extractMediaImageSrcs(markdowns: readonly string[]): string[] {
  // 字面量求值即新对象（非模块级共享）：/g 正则被 matchAll 提前中止会留下
  // 非零 lastIndex，共享实例会跨调用串状态
  const pattern =
    /::image\{[^}\n]*?\bsrc="(blobs\/media\/[0-9a-f]{64}\.(?:png|jpe?g|webp|gif))"/g;
  const seen = new Set<string>();
  for (const md of markdowns) {
    for (const match of md.matchAll(pattern)) {
      const src = match[1];
      if (src !== undefined) seen.add(src);
    }
  }
  // Set 保插入序：同图多处引用只收集一次，条目顺序稳定可测
  return [...seen];
}

/**
 * 魔数检测：命中白名单返回规范化扩展名（JPEG → jpg），其余 null。
 * 只看文件头字节，不看上传方声明的 MIME/文件名（两者都可伪造）。
 */
function detectImageExt(
  bytes: Uint8Array,
): "png" | "jpg" | "webp" | "gif" | null {
  /** bytes 从 offset 起是否以 signature 开头 */
  const has = (signature: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length &&
    signature.every((expected, i) => bytes[offset + i] === expected);
  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  // JPEG：FF D8 FF
  if (has([0xff, 0xd8, 0xff])) {
    return "jpg";
  }
  // GIF87a / GIF89a
  if (
    has([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    has([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "gif";
  }
  // WEBP：0-3 为 RIFF、8-11 为 WEBP（中间 4 字节是文件长度）
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  return null;
}

/** 图片落盘目录（懒建）：DATA_DIR/blobs/media（写法同 ink-service 的 inkDir） */
function mediaDir(dataDir: string): string {
  const dir = join(dataDir, "blobs", "media");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写文件：先写 <名>.tmp 再 rename 覆盖（写一半崩溃不留半截文件） */
function writeFileAtomic(filePath: string, bytes: Uint8Array): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, filePath);
}

/**
 * 保存一张上传图片（multipart 解析后的文件字节）：
 * - 魔数不在 PNG/JPEG/GIF/WEBP 白名单 → 415 UNSUPPORTED_MEDIA_TYPE；
 * - 超过 5MB → 413 MEDIA_TOO_LARGE（content-length 粗防线管不到的 chunked
 *   场景由此按实际字节数兜底）；
 * - sha256 内容寻址落盘 blobs/media/<hash>.<ext>；文件已存在则幂等跳过写入
 *   （同名即同内容，不会也不需要覆盖）；
 * - 返回 { src, bytes }，返回前经 mediaUploadResultSchema.parse 校验
 *   （契约是单一事实源；此处失败说明 service 与契约漂移，属编程错误）。
 */
export function saveMedia(
  dataDir: string,
  bytes: Uint8Array,
): MediaUploadResult {
  const ext = detectImageExt(bytes);
  if (ext === null) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "图片格式不受支持，仅接受 PNG、JPG、WEBP、GIF",
    );
  }
  if (bytes.byteLength > MEDIA_MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      "MEDIA_TOO_LARGE",
      "图片超过 5MB 上传上限，请压缩后重试",
    );
  }
  // 小写 sha256 hex（digest 默认即小写）。bytes 可能是 Buffer 的视图，
  // 按其字节区间取视图喂哈希（同 ink-service pngSize 的写法）
  const hash = createHash("sha256")
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest("hex");
  const filePath = join(mediaDir(dataDir), `${hash}.${ext}`);
  if (!existsSync(filePath)) {
    writeFileAtomic(filePath, bytes);
  }
  return mediaUploadResultSchema.parse({
    src: `blobs/media/${hash}.${ext}`,
    bytes: bytes.byteLength,
  });
}

/** 扩展名 → Content-Type（blobs 伺服自建小映射；static.ts 的 CONTENT_TYPES 是 web/dist 托管专用） */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 伺服读取结果（/blobs/* 路由直出用） */
export interface MediaBlob {
  /** 文件字节（独立 ArrayBuffer 拷贝，脱离 Node Buffer 视图——Response BodyInit 类型友好，同 ink-service） */
  bytes: ArrayBuffer;
  /** 按扩展名映射的 Content-Type */
  contentType: string;
}

/**
 * 按单段文件名读回图片（app.ts 的 /blobs/media/<名> 路由剥掉字面 media/
 * 前缀段后传入；也可以在已持有文件名的任何调用点直接使用）：
 * - 文件名必须整体匹配 MEDIA_BLOB_FILENAME_PATTERN——多段路径（如 ink/xxx.png）、
 *   `..` 穿越、大写 hash、非白名单扩展名一律按未命中（null）处理，调用方回 404。
 *   正则只放行「64 位小写 hex + 点 + 图片扩展名」的单段名，join 的落点永远在
 *   blobs/media/ 内：路径穿越与 blobs/ink/ 等其他子目录天然不可达（测试锁定）；
 * - 文件不存在（未上传过/已清理）→ null。
 */
export function readMediaBlob(
  dataDir: string,
  filename: string,
): MediaBlob | null {
  if (!MEDIA_BLOB_FILENAME_PATTERN.test(filename)) {
    return null;
  }
  const ext = filename.slice(filename.lastIndexOf(".") + 1);
  const contentType = MEDIA_CONTENT_TYPES[ext];
  // 理论不可达（正则已限定扩展名白名单），纵深防御兜底
  if (contentType === undefined) {
    return null;
  }
  try {
    const buf = readFileSync(join(dataDir, "blobs", "media", filename));
    return {
      bytes: buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
      contentType,
    };
  } catch {
    return null;
  }
}
