import { describe, expect, it } from "vitest";
import { mediaUploadResultSchema } from "./media-api";

/** 图片上传响应契约（媒体管线第一单）：src 内容寻址形态 + bytes 正整数 */
const hash = "9af3".padEnd(64, "0");

describe("mediaUploadResultSchema", () => {
  it("合法：四种扩展名（含 jpeg 长写法）的 blobs/media/<64 位哈希> 路径 + 正整数 bytes", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
      const parsed = mediaUploadResultSchema.safeParse({
        src: `blobs/media/${hash}.${ext}`,
        bytes: 1024,
      });
      expect(parsed.success, ext).toBe(true);
    }
  });

  it("src 拒绝：外链 URL、旧式散路径、大写/短哈希、目录穿越、未知扩展名", () => {
    for (const src of [
      "https://cdn.example.com/fig.png",
      "blobs/fig-1.png",
      `blobs/media/${"A".repeat(64)}.png`,
      "blobs/media/9af3.png",
      `blobs/media/${hash}.svg`,
      `../blobs/media/${hash}.png`,
    ]) {
      expect(
        mediaUploadResultSchema.shape.src.safeParse(src).success,
        src,
      ).toBe(false);
    }
  });

  it("bytes 拒绝：0、负数、非整数", () => {
    for (const bytes of [0, -1, 1.5]) {
      expect(
        mediaUploadResultSchema.shape.bytes.safeParse(bytes).success,
        String(bytes),
      ).toBe(false);
    }
  });
});
