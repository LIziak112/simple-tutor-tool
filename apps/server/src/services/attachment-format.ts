import type { AttachmentFormat } from "@tutor/contract";
import { ATTACHMENT_FILE_NAME_MAX } from "@tutor/contract";
import { isDocxPackage } from "./attachment-docx";

/**
 * 资料附件的纯函数（模块 6 第一步）：按内容识别格式、PDF 页数、展示文件名清洗。
 * 与存储 / 权限无关，attachment-service 与测试共用；以后加格式（如 pptx）只改这里。
 */

/** 按内容识别格式；都不是 → null */
export function detectAttachmentFormat(
  bytes: Uint8Array,
): AttachmentFormat | null {
  if (bytes.byteLength < 8) return null;
  // PDF：规范允许文件头前有少量垃圾字节，取前 1KB 找 %PDF-
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 1024),
  ).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  // DOCX 按 OPC 包关系核对主文档的实际内容。
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    if (
      isDocxPackage(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      )
    ) {
      return "docx";
    }
  }
  return null;
}

/** PDF 页数：/Type /Pages 字典附近最大的 /Count；读不到 → null */
export function pdfPageCountOf(bytes: Uint8Array): number | null {
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("latin1");
  let max = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b/g)) {
    const start = Math.max(0, match.index - 400);
    const window = text.slice(start, match.index + 400);
    for (const count of window.matchAll(/\/Count\s+(\d+)/g)) {
      max = Math.max(max, Number(count[1]));
    }
  }
  return max > 0 ? max : null;
}

/** 逐码点迭代时，孤立代理项会以单个 UTF-16 单元出现（码位落在 D800–DFFF） */
function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * 按码点截断到不超过 maxUnits 个 UTF-16 单元（契约 .max(200) 按 UTF-16 计），
 * 放不下的整个码点丢掉——不会把表情等代理对劈成两半（#103-03）。
 */
function truncateByCodePoint(text: string, maxUnits: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

/**
 * 孤立代理项 → U+FFFD（等价 String.prototype.toWellFormed；tsconfig lib 为
 * ES2023 没带它的类型）。下载直出前的最后防线：encodeURIComponent 遇到孤立
 * 代理项会抛 URIError，历史脏数据也要能下载。
 */
export function wellFormedFileName(name: string): string {
  let out = "";
  for (const ch of name) {
    out += isLoneSurrogate(ch.codePointAt(0) ?? 0) ? "\ufffd" : ch;
  }
  return out;
}

function truncateAttachmentFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  return `${truncateByCodePoint(name, ATTACHMENT_FILE_NAME_MAX - ext.length)}${ext}`;
}

/** 去掉 U+0000–U+001F、U+007F 和孤立代理项。 */
function isDisplayFileNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code > 0x1f && code !== 0x7f && !isLoneSurrogate(code);
}

/** 展示文件名：去路径、去控制字符 / 孤立代理项、收空白、≤200（保留扩展名）；空 → 资料.<ext> */
export function sanitizeAttachmentFileName(
  raw: string | undefined,
  format: AttachmentFormat,
): string {
  const base = raw?.split(/[\\/]/).pop() ?? "";
  // 先把各种空白（含 \t）收成单个空格，再逐码点过滤。
  const name = Array.from(base.replace(/\s+/g, " "))
    .filter(isDisplayFileNameCharacter)
    .join("")
    .trim();
  if (name === "" || name === "." || name === "..") {
    return `资料.${format}`;
  }
  return name.length > ATTACHMENT_FILE_NAME_MAX
    ? truncateAttachmentFileName(name)
    : name;
}
