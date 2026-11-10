import { describe, expect, it } from "vitest";
import {
  detectMemoImageFormat,
  detectMemoMediaFormat,
  detectVoiceFormat,
} from "./memo-format.ts";

/**
 * 随笔媒体格式识别（模块 5 第一步）：语音六格式魔数（webm / m4a / mp4 / ogg /
 * wav / mp3 两种头）；图片复用 ::image 白名单；形态与内容不符 → null。
 */

function bytesOf(head: string, pad = 16): Uint8Array {
  const out = new Uint8Array(Math.max(pad, head.length));
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0xff;
  return out;
}

/** 前 4 字节 box 长度 + "ftyp" + 品牌 */
function isoBmff(brand: string): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x00, 0x00, 0x00, 0x18], 0);
  out.set(bytesOf("ftyp", 4), 4);
  out.set(bytesOf(brand, 4), 8);
  return out;
}

export const MEMO_TEST_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
export const MEMO_TEST_WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
]);
export const MEMO_TEST_M4A = isoBmff("M4A ");

describe("detectVoiceFormat", () => {
  it("识别 webm / m4a / mp4 / ogg / wav / mp3", () => {
    expect(detectVoiceFormat(MEMO_TEST_WEBM)).toBe("webm");
    expect(detectVoiceFormat(MEMO_TEST_M4A)).toBe("m4a");
    expect(detectVoiceFormat(isoBmff("isom"))).toBe("mp4");
    expect(detectVoiceFormat(isoBmff("mp42"))).toBe("mp4");
    expect(detectVoiceFormat(bytesOf("OggS"))).toBe("ogg");
    const wav = bytesOf("RIFF", 16);
    wav.set(bytesOf("WAVE", 4), 8);
    expect(detectVoiceFormat(wav)).toBe("wav");
    expect(detectVoiceFormat(bytesOf("ID3"))).toBe("mp3");
    expect(detectVoiceFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe(
      "mp3",
    );
  });

  it("RIFF 但不是 WAVE（如 AVI）、纯文本、空字节 → null", () => {
    const avi = bytesOf("RIFF", 16);
    avi.set(bytesOf("AVI ", 4), 8);
    expect(detectVoiceFormat(avi)).toBeNull();
    expect(detectVoiceFormat(bytesOf("hello world"))).toBeNull();
    expect(detectVoiceFormat(new Uint8Array(0))).toBeNull();
  });
});

describe("detectMemoMediaFormat", () => {
  it("图片 / 手写走 ::image 白名单；形态与内容不符 → null", () => {
    expect(detectMemoImageFormat(MEMO_TEST_PNG)).toBe("png");
    expect(detectMemoMediaFormat("image", MEMO_TEST_PNG)).toBe("png");
    expect(detectMemoMediaFormat("ink", MEMO_TEST_PNG)).toBe("png");
    expect(detectMemoMediaFormat("voice", MEMO_TEST_PNG)).toBeNull();
    expect(detectMemoMediaFormat("image", MEMO_TEST_WEBM)).toBeNull();
    expect(detectMemoMediaFormat("voice", MEMO_TEST_WEBM)).toBe("webm");
  });
});
