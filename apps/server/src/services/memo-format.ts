import type {
  MemoImageFormat,
  MemoKind,
  MemoMediaFormat,
  MemoVoiceFormat,
} from "@tutor/contract";
import { detectImageExt } from "./media-service";

/**
 * 随笔媒体格式识别（模块 5 第一步）：只看文件内容，不信上传方的 MIME / 文件名
 * （与 media-service / attachment-format 同纪律）。
 * - 语音（kind=voice）：浏览器 MediaRecorder 原格式——Safari audio/mp4（ISO BMFF，
 *   品牌 M4A / isom / mp42 …）、Chrome / Firefox audio/webm 或 audio/ogg（opus）；
 *   另收 wav / mp3（外部录音文件）；
 * - 图片 / 手写（kind=image | ink）：PNG / JPEG / GIF / WebP（::image 媒体白名单）。
 * 形态与内容不符（如把图片当语音传）→ null → 415。
 */

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((expected, i) => bytes[offset + i] === expected)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** 音频魔数 → 格式；未命中 null */
export function detectVoiceFormat(bytes: Uint8Array): MemoVoiceFormat | null {
  // EBML 头（webm / mkv）：1A 45 DF A3
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  // ISO BMFF：第 4–7 字节 "ftyp"；品牌 "M4A " 记 m4a，其余（isom / mp42 / iso5 …）记 mp4
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    return ascii(bytes, 8, 4) === "M4A " ? "m4a" : "mp4";
  }
  // Ogg："OggS"
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  // WAV："RIFF" + 第 8–11 字节 "WAVE"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return "wav";
  }
  // MP3：ID3v2 标签头，或帧同步 FF Ex / FF Fx
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (
    bytes.length >= 4 &&
    b0 === 0xff &&
    b1 !== undefined &&
    (b1 & 0xe0) === 0xe0 &&
    (b1 & 0x06) !== 0
  ) {
    return "mp3";
  }
  return null;
}

/** 图片 / 手写：复用 ::image 媒体的白名单识别 */
export function detectMemoImageFormat(
  bytes: Uint8Array,
): MemoImageFormat | null {
  return detectImageExt(bytes);
}

/** 按声明形态识别内容；形态与内容不符返回 null */
export function detectMemoMediaFormat(
  kind: Exclude<MemoKind, "text">,
  bytes: Uint8Array,
): MemoMediaFormat | null {
  return kind === "voice"
    ? detectVoiceFormat(bytes)
    : detectMemoImageFormat(bytes);
}
