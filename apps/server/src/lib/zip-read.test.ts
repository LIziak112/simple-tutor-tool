import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeZipEntryName, readZipEntries, ZipReadError } from "./zip-read.ts";

/**
 * 最小 zip 读取器测试（T4.5）：与 archiver（写入端，技术栈内依赖）往返；
 * 损坏输入各失败路径；条目名安全校验。
 * 运行时为 Node ≥24（zlib.crc32 内置）。
 */

/** 用 archiver 把若干文件打成 zip Buffer（与备份下载同一写入端） */
async function zipOf(
  files: ReadonlyArray<{ name: string; data: Buffer }>,
  level = 6,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err: Error) => reject(err));
  });
  for (const file of files) {
    archive.append(file.data, { name: file.name });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

let dir: string;
afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  }
});

describe("readZipEntries：与 archiver 往返", () => {
  it("deflate（level 6）与 stored（level 0）都能原样读回", async () => {
    const files = [
      { name: "tutor-20261001-120000.db", data: Buffer.from([1, 2, 3, 4, 5]) },
      { name: "blobs/ink/a/x.json.gz", data: Buffer.alloc(1024, 7) },
      { name: "shared/讲义样例.md", data: Buffer.from("中文内容", "utf8") },
      { name: "secret.key", data: Buffer.from("ab".repeat(32), "utf8") },
    ];
    for (const level of [0, 6]) {
      const zip = await zipOf(files, level);
      const entries = readZipEntries(zip);
      expect(entries.map((entry) => entry.name)).toEqual(files.map((f) => f.name));
      for (let i = 0; i < files.length; i += 1) {
        expect(entries[i]?.data.equals(files[i]?.data as Buffer)).toBe(true);
      }
    }
  });

  it("archive.directory 打包的嵌套目录（含目录条目）可读回全部文件", async () => {
    dir = mkdtempSync(join(tmpdir(), "tutor-zipread-"));
    mkdirSync(join(dir, "blobs", "ink", "a"), { recursive: true });
    writeFileSync(join(dir, "blobs", "ink", "a", "x.png"), Buffer.from("png"));
    writeFileSync(join(dir, "blobs", "ink", "b.json.gz"), Buffer.from("gz"));

    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", (err: Error) => reject(err));
    });
    archive.directory(join(dir, "blobs"), "blobs");
    await archive.finalize();
    await done;

    const entries = readZipEntries(Buffer.concat(chunks));
    const names = entries.map((entry) => entry.name).sort();
    // 目录条目（以 / 结尾）被跳过，只剩文件
    expect(names).toEqual([
      "blobs/ink/a/x.png",
      "blobs/ink/b.json.gz",
    ]);
    expect(entries.find((entry) => entry.name === "blobs/ink/a/x.png")?.data.toString()).toBe("png");
  });
});

describe("readZipEntries：损坏与不支持", () => {
  it("随机字节不是 zip", () => {
    const junk = Buffer.alloc(500, 0xab);
    expect(() => readZipEntries(junk)).toThrow("不是有效的 zip 文件");
  });

  it("真实 zip 截断（EOCD 丢失）被拒绝", async () => {
    const zip = await zipOf([{ name: "a.txt", data: Buffer.from("hello") }]);
    const truncated = zip.subarray(0, Math.floor(zip.length / 2));
    expect(() => readZipEntries(Buffer.from(truncated))).toThrow(ZipReadError);
  });

  it("数据区被篡改导致校验失败（原文件损坏路径）", async () => {
    const zip = Buffer.from(
      await zipOf([{ name: "a.txt", data: Buffer.from("hello world") }]),
    );
    // 翻转本地数据区中的一个字节（首个条目数据靠前；无论命中数据还是
    // 中央目录都会被签名 / CRC / 大小校验之一拦下）
    zip[45] = (zip[45] as number) ^ 0xff;
    expect(() => readZipEntries(zip)).toThrow(ZipReadError);
  });

  it("空 zip（0 条目）被拒绝", async () => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", (err: Error) => reject(err));
    });
    await archive.finalize();
    await done;
    expect(() => readZipEntries(Buffer.concat(chunks))).toThrow("压缩包为空");
  });

  it("过小 buffer（连 EOCD 都放不下）被拒绝", () => {
    expect(() => readZipEntries(Buffer.alloc(4))).toThrow(ZipReadError);
  });
});

describe("isSafeZipEntryName", () => {
  it("接受干净的相对路径（含中文与嵌套）", () => {
    expect(isSafeZipEntryName("tutor.db")).toBe(true);
    expect(isSafeZipEntryName("blobs/ink/a-b/x.json.gz")).toBe(true);
    expect(isSafeZipEntryName("shared/讲义样例.md")).toBe(true);
    expect(isSafeZipEntryName("secret.key")).toBe(true);
  });

  it("拒绝路径穿越 / 绝对路径 / 盘符 / 反斜杠 / 空段", () => {
    expect(isSafeZipEntryName("../evil.txt")).toBe(false);
    expect(isSafeZipEntryName("a/../../evil.txt")).toBe(false);
    expect(isSafeZipEntryName("/abs/path.txt")).toBe(false);
    expect(isSafeZipEntryName("C:\\Windows\\evil.txt")).toBe(false);
    expect(isSafeZipEntryName("c:/evil.txt")).toBe(false);
    expect(isSafeZipEntryName("a\\b.txt")).toBe(false);
    expect(isSafeZipEntryName("a//b.txt")).toBe(false);
    expect(isSafeZipEntryName("./a.txt")).toBe(false);
    expect(isSafeZipEntryName("a/.hidden.txt")).toBe(true); // '.hidden' 不是 '.' 段
    expect(isSafeZipEntryName("")).toBe(false);
  });
});
