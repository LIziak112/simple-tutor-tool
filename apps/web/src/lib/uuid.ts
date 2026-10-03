/**
 * RFC 4122 v4 UUID 生成（安全上下文与 HTTP 通用）。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）存在——线上以
 * http://IP 部署时它是 undefined，裸调用会抛 TypeError（曾致导入页选完
 * 文件清单不更新，2026-10 修复）。降级用 `crypto.getRandomValues` 手搓
 * v4：该 API 不受安全上下文限制；再兜底 Math.random（理论环境）。
 * 与 lib/copy.ts 对 navigator.clipboard 的降级同理。
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // 第 7 字节高 4 位 = 版本 4；第 9 字节高 2 位 = variant 10
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
