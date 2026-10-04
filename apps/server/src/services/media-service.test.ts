import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDir } from "../db/test-utils";
import { HttpError } from "../lib/http-error";
import {
  extractMediaImageSrcs,
  MEDIA_BLOB_URL_TAIL_PATTERN,
  MEDIA_MAX_UPLOAD_BYTES,
  readMediaBlob,
  saveMedia,
} from "./media-service";

/**
 * MediaService 单元测试（媒体管线第二单验收项）：
 * - 四种格式魔数（PNG/JPEG/GIF87a/GIF89a/WEBP）通过且扩展名规范化（JPEG → jpg）；
 * - svg 文本、纯文本 → 415 UNSUPPORTED_MEDIA_TYPE；
 * - 超 5MB → 413 MEDIA_TOO_LARGE（恰 5MB 边界通过）；
 * - 同字节幂等（两次调用同 src；文件已存在时跳过重写）；
 * - 不同字节不同 src；
 * - readMediaBlob：合法单段名读回字节与 Content-Type；多段路径/穿越/大写
 *   hash/未知扩展名/文件不存在一律 null（/blobs/* 伺服安全口径，测试锁定）。
 */

/** 断言 fn 抛出指定状态码与错误码的 HttpError */
function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string,
): void {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    return;
  }
  throw new Error("应当抛出 HttpError，但正常返回了");
}

/** 最小 PNG 字节（魔数 + 填充；saveMedia 只看魔数，伺服只回原字节） */
function makePng(tailBytes = 24): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(tailBytes, 0xab),
    ]),
  );
}

/** JPEG（FF D8 FF + 填充） */
const JPEG_BYTES = new Uint8Array(
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(20, 0x11),
  ]),
);

/** WEBP（RIFF + 长度 + WEBP + 填充） */
const WEBP_BYTES = new Uint8Array(
  Buffer.concat([
    Buffer.from("RIFF\x18\x00\x00\x00WEBPVP8 ", "latin1"),
    Buffer.alloc(8, 0x22),
  ]),
);

/** src（blobs/media/<名>）→ DATA_DIR 下的绝对路径 */
function srcToPath(dataDir: string, src: string): string {
  return join(dataDir, ...src.split("/"));
}

describe("saveMedia：魔数白名单与扩展名规范化", () => {
  it("PNG 通过：src 形如 blobs/media/<64 hex>.png，文件落盘且字节一致", () => {
    const dataDir = createTestDir();
    const bytes = makePng();
    const result = saveMedia(dataDir, bytes);
    expect(result.src).toMatch(/^blobs\/media\/[0-9a-f]{64}\.png$/);
    expect(result.bytes).toBe(bytes.byteLength);
    const file = srcToPath(dataDir, result.src);
    expect(existsSync(file)).toBe(true);
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
  });

  it("JPEG 通过且统一存为 .jpg（扩展名规范化）", () => {
    const dataDir = createTestDir();
    const result = saveMedia(dataDir, JPEG_BYTES);
    expect(result.src).toMatch(/^blobs\/media\/[0-9a-f]{64}\.jpg$/);
    expect(existsSync(srcToPath(dataDir, result.src))).toBe(true);
  });

  it("GIF87a 与 GIF89a 都通过且存为 .gif", () => {
    const dataDir = createTestDir();
    const gif89a = new Uint8Array(Buffer.from("GIF89a\x00\x00", "latin1"));
    const gif87a = new Uint8Array(Buffer.from("GIF87a\x00\x00", "latin1"));
    expect(saveMedia(dataDir, gif89a).src).toMatch(/\.gif$/);
    expect(saveMedia(dataDir, gif87a).src).toMatch(/\.gif$/);
  });

  it("WEBP（RIFF…WEBP）通过且存为 .webp", () => {
    const dataDir = createTestDir();
    expect(saveMedia(dataDir, WEBP_BYTES).src).toMatch(/\.webp$/);
  });

  it("svg 文本字节 → 415 UNSUPPORTED_MEDIA_TYPE，不落盘", () => {
    const dataDir = createTestDir();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expectHttpError(
      () => saveMedia(dataDir, svg),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(existsSync(join(dataDir, "blobs"))).toBe(false);
  });

  it("纯文本 → 415 UNSUPPORTED_MEDIA_TYPE", () => {
    const dataDir = createTestDir();
    const text = new TextEncoder().encode("hello, 这不是图片");
    expectHttpError(
      () => saveMedia(dataDir, text),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });
});

describe("saveMedia：5MB 限额与幂等", () => {
  it("超过 5MB 的 PNG → 413 MEDIA_TOO_LARGE，不落盘", () => {
    const dataDir = createTestDir();
    const tooBig = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(MEDIA_MAX_UPLOAD_BYTES + 1 - 8, 0x33),
      ]),
    );
    expectHttpError(() => saveMedia(dataDir, tooBig), 413, "MEDIA_TOO_LARGE");
    expect(existsSync(join(dataDir, "blobs"))).toBe(false);
  });

  it("恰好 5MB 通过（边界含在限额内）", () => {
    const dataDir = createTestDir();
    const exact = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(MEDIA_MAX_UPLOAD_BYTES - 8, 0x44),
      ]),
    );
    expect(saveMedia(dataDir, exact).bytes).toBe(MEDIA_MAX_UPLOAD_BYTES);
  });

  it("同字节幂等：两次调用同 src；文件已存在时跳过重写", () => {
    const dataDir = createTestDir();
    const bytes = makePng();
    const first = saveMedia(dataDir, bytes);
    const second = saveMedia(dataDir, bytes);
    expect(second.src).toBe(first.src);
    // 手动改写落盘文件后再存同字节：existsSync 命中即跳过，文件内容保持手动
    // 字节——证明幂等策略是「跳过写入」而非「重写同内容」
    const file = srcToPath(dataDir, first.src);
    writeFileSync(file, Buffer.from("手动占位"));
    saveMedia(dataDir, bytes);
    expect(readFileSync(file, "utf8")).toBe("手动占位");
  });

  it("不同字节不同 src（内容寻址）", () => {
    const dataDir = createTestDir();
    const a = saveMedia(dataDir, makePng(24));
    const b = saveMedia(dataDir, makePng(25));
    expect(a.src).not.toBe(b.src);
    expect(existsSync(srcToPath(dataDir, a.src))).toBe(true);
    expect(existsSync(srcToPath(dataDir, b.src))).toBe(true);
  });
});

describe("readMediaBlob：/blobs/* 伺服读取", () => {
  /** 上传一张 PNG 并返回其单段文件名（src 的最后一段） */
  function uploadOne(dataDir: string): string {
    return saveMedia(dataDir, makePng()).src.split("/").pop() ?? "";
  }

  it("合法文件名读回字节与 Content-Type", () => {
    const dataDir = createTestDir();
    const name = uploadOne(dataDir);
    const blob = readMediaBlob(dataDir, name);
    expect(blob).not.toBeNull();
    expect(blob?.contentType).toBe("image/png");
    expect(new Uint8Array(blob?.bytes ?? new ArrayBuffer(0))).toEqual(
      makePng(),
    );
  });

  it("jpg/jpeg/webp/gif 的 Content-Type 映射", () => {
    const dataDir = createTestDir();
    // 正则放行的扩展名各造一个空文件，验证映射（读取不校验内容）
    mkdirSync(join(dataDir, "blobs", "media"), { recursive: true });
    for (const [name, expected] of [
      [`${"0".repeat(64)}.jpg`, "image/jpeg"],
      [`${"0".repeat(64)}.jpeg`, "image/jpeg"],
      [`${"0".repeat(64)}.webp`, "image/webp"],
      [`${"0".repeat(64)}.gif`, "image/gif"],
    ] as const) {
      writeFileSync(join(dataDir, "blobs", "media", name), Buffer.from("x"));
      expect(readMediaBlob(dataDir, name)?.contentType).toBe(expected);
    }
  });

  it("不存在的 hash → null", () => {
    const dataDir = createTestDir();
    expect(readMediaBlob(dataDir, `${"a".repeat(64)}.png`)).toBeNull();
  });

  it("非单段/穿越/大小写/未知扩展名一律 null（伺服安全口径）", () => {
    const dataDir = createTestDir();
    const hash = "b".repeat(64);
    // 这些文件即使真实存在也读不到（正则先行拒绝，不触盘）
    mkdirSync(join(dataDir, "blobs", "ink"), { recursive: true });
    writeFileSync(
      join(dataDir, "blobs", "ink", `${hash}.png`),
      Buffer.from("ink"),
    );
    for (const evil of [
      `media/${hash}.png`, // 多段：URL 的 media/ 前缀段由 app.ts 路由层剥离后传入，本函数只收单段文件名
      `ink/${hash}.png`, // 多段：笔迹 blobs/ink/ 下真实存在也不可达
      `../${hash}.png`, // 穿越
      "media/../../secret", // 深层穿越
      `${hash.toUpperCase()}.png`, // 大写 hex 不在形态内
      `${hash}.svg`, // 扩展名白名单外
      `${hash.slice(0, 63)}.png`, // hash 不足 64 位
      "", // /blobs/ 前缀后无内容
    ]) {
      expect(readMediaBlob(dataDir, evil)).toBeNull();
    }
  });

  it("URL 尾段形态：media/<名> 命中并捕获文件名；缺 media 段/其他子目录/穿越拒绝", () => {
    const name = `${"c".repeat(64)}.png`;
    const match = MEDIA_BLOB_URL_TAIL_PATTERN.exec(`media/${name}`);
    expect(match?.[1]).toBe(name);
    // jpg/jpeg 两种写法都放行（与文件名正则同源）
    expect(
      MEDIA_BLOB_URL_TAIL_PATTERN.exec(`media/${"c".repeat(64)}.jpg`),
    ).not.toBeNull();
    expect(
      MEDIA_BLOB_URL_TAIL_PATTERN.exec(`media/${"c".repeat(64)}.jpeg`),
    ).not.toBeNull();
    for (const evil of [
      name, // 缺 media 前缀段
      `MEDIA/${name}`, // 前缀段大小写敏感
      `ink/${name}`, // 其他子目录
      `media/../${name}`, // 穿越
      `media/${name}/extra`, // 尾部多段
      `media/`, // 前缀段后无文件名
      "", // 裸前缀
    ]) {
      expect(MEDIA_BLOB_URL_TAIL_PATTERN.exec(evil)).toBeNull();
    }
  });
});

describe("extractMediaImageSrcs（::image 引用提取纯函数，自 export-service 迁入）", () => {
  const H1 = "a".repeat(64);
  const H2 = "0123456789abcdef".repeat(4);

  it("提取严格形态引用：src 位置无关、去重保序", () => {
    const md = [
      `::image{src="blobs/media/${H1}.png"}`,
      `::image{alt="前缀属性" src="blobs/media/${H2}.jpg"}`,
      `::image{src="blobs/media/${H1}.png"}`, // 重复引用 → 只收集一份
    ].join("\n\n");
    expect(extractMediaImageSrcs([md])).toEqual([
      `blobs/media/${H1}.png`,
      `blobs/media/${H2}.jpg`,
    ]);
  });

  it("非契约形态静默跳过（旧式路径/外链/大写 hash/短 hash/其他目录）", () => {
    const md = [
      '::image{src="blobs/fig-1.png"}',
      '::image{src="https://example.com/a.png"}',
      `::image{src="blobs/media/${H1.toUpperCase()}.png"}`,
      `::image{src="blobs/media/${"a".repeat(63)}.png"}`,
      '::image{src="blobs/ink/whatever.png"}',
      '正文里没有指令的 src="blobs/media/…" 不算数',
    ].join("\n");
    expect(extractMediaImageSrcs([md])).toEqual([]);
  });

  it("跨多段文本收集且不重复；题干/详解形态的题目 md 同样命中", () => {
    const stem = `题干：观察下图。::image{src="blobs/media/${H1}.webp"}`;
    const solution = `详解：如图。::image{src="blobs/media/${H2}.gif"}`;
    expect(extractMediaImageSrcs([stem, solution, stem])).toEqual([
      `blobs/media/${H1}.webp`,
      `blobs/media/${H2}.gif`,
    ]);
  });
});
