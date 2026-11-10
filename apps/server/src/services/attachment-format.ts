import type { AttachmentFormat } from "@tutor/contract";
import { ATTACHMENT_FILE_NAME_MAX } from "@tutor/contract";

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
  // docx：ZIP 本地文件头 + 包内 word/document.xml（条目名在 ZIP 里是明文）
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    const all = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("latin1");
    if (all.includes("word/document.xml")) return "docx";
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

/** 展示文件名：去路径、去控制字符、收空白、≤200（保留扩展名）；空 → 资料.<ext> */
export function sanitizeAttachmentFileName(
  raw: string | undefined,
  format: AttachmentFormat,
): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // 先把各种空白（含 \t）收成单个空格，再逐字符剔除控制字符
  // （U+0000–U+001F、U+007F；不用含控制字符的正则）
  let name = Array.from(base.replace(/\s+/g, " "))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (name.length === 0 || name === "." || name === "..") {
    name = `资料.${format}`;
  }
  if (name.length > ATTACHMENT_FILE_NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
    name = `${name.slice(0, ATTACHMENT_FILE_NAME_MAX - ext.length)}${ext}`;
  }
  return name;
}
