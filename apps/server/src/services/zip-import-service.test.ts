import { crc32 } from "node:zlib";
import { ZipArchive } from "archiver";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import {
  basenameOf,
  decodeImportZipBase64,
  extractImageRefs,
  isExternalSrc,
  pairImageRefs,
  rewriteImageSrcs,
  unpackImportZip,
  ZIP_IMPORT_MAX_ENTRIES,
} from "./zip-import-service.ts";

/**
 * ZipImportService 纯函数与解包测试（MCP import_zip 的服务端实现）：
 * - 配对三规则（精确 → basename 唯一 → 冲突不配对）与外链排除；
 * - 改写只动配对成功的 src 引号内值，其余逐字节不变；
 * - 解包：任意层级 .md 识别 / BOM 剥离 / 忽略清单 / 三项限额 / 危险条目名；
 * - base64 解码与 upload_image 同口径（容忍折行、非法报中文错误）。
 * 编排（previewZipImport / commitZipImport）经 MCP 工具全链路测试覆盖
 * （mcp/mcp.test.ts 的 import_zip 组），此处不重复搭库。
 */

/** 用 archiver 把若干文件打成 zip Buffer（与 zip-read.test.ts 同款写入端） */
async function zipOf(
  files: ReadonlyArray<{ name: string; data: Buffer }>,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
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

// ---------- 手工构造 stored zip（archiver 会清洗 ../ 名，危险条目名只能手打） ----------

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

/** 最小 stored（method 0）zip：条目名原样写入（含 ../ 等危险名），逐条 CRC 正确 */
function rawStoredZip(
  files: ReadonlyArray<{ name: string; data: Buffer }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), // 本地文件头签名
      u16(20), // 版本
      u16(0x0800), // UTF-8 名标志
      u16(0), // method 0 = stored
      u16(0),
      u16(0), // 时间 / 日期
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // 中央目录签名
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    cd,
    u32(0x06054b50), // EOCD 签名
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
}

/** 最小 PNG 字节（魔数 + 填充；saveMedia 只看魔数） */
function pngBytes(fill = 0xab): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16, fill),
  ]);
}

/** 断言业务错误码（HttpError 非 code 直接 fail） */
function expectHttpError(fn: () => unknown, code: string): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(code);
    return err as HttpError;
  }
  throw new Error(`期望抛 ${code}，实际未抛`);
}

// ---------- base64 解码 ----------

describe("decodeImportZipBase64", () => {
  it("容忍折行空白，正确解码", () => {
    const zip = Buffer.from("zip-bytes-测试");
    const folded = `${zip.toString("base64").slice(0, 6)}\n  ${zip
      .toString("base64")
      .slice(6)}`;
    expect(decodeImportZipBase64(folded, "a.zip").equals(zip)).toBe(true);
  });

  it("非法 base64 → INVALID_BASE64，中文提示带 zip 名", () => {
    const err = expectHttpError(
      () => decodeImportZipBase64("不是-base64!!", "讲义包.zip"),
      "INVALID_BASE64",
    );
    expect(err.message).toContain("「讲义包.zip」");
    expect(err.message).toContain("base64");
  });
});

// ---------- 解包与限额 ----------

describe("unpackImportZip", () => {
  it("三分条目：任意层级 .md（含 .markdown/.MD）、图片、忽略清单；BOM 剥离", async () => {
    const md = "---\nkind: lecture\n---\n\n# 标题\n";
    const bomMd = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(md, "utf8"),
    ]);
    const zip = await zipOf([
      { name: "讲义.md", data: Buffer.from(md, "utf8") },
      { name: "chapter1/nested/练习.markdown", data: Buffer.from(md, "utf8") },
      { name: "UPPER.MD", data: Buffer.from(md, "utf8") },
      { name: "bom.md", data: bomMd },
      { name: "img/fig1.png", data: pngBytes() },
      { name: "fig2.jpg", data: pngBytes(0xcd) },
      { name: "notes.txt", data: Buffer.from("hi") },
      { name: "sub/data.csv", data: Buffer.from("1,2") },
    ]);
    const bundle = unpackImportZip(zip);
    expect(bundle.mdFiles.map((f) => f.path)).toEqual([
      "讲义.md",
      "chapter1/nested/练习.markdown",
      "UPPER.MD",
      "bom.md",
    ]);
    // BOM 已剥（首字符是 '-' 而不是 U+FEFF）
    expect(bundle.mdFiles[3]?.markdown.startsWith("---")).toBe(true);
    expect(bundle.imageEntries.map((e) => e.name)).toEqual([
      "img/fig1.png",
      "fig2.jpg",
    ]);
    const firstImage = bundle.imageEntries[0];
    expect(
      firstImage !== undefined &&
        Buffer.from(firstImage.data).equals(pngBytes()),
    ).toBe(true);
    expect(bundle.ignoredFiles).toEqual(["notes.txt", "sub/data.csv"]);
  });

  it("没有 .md → ZIP_NO_MARKDOWN（中文错误）", async () => {
    const zip = await zipOf([{ name: "a.png", data: pngBytes() }]);
    expectHttpError(() => unpackImportZip(zip), "ZIP_NO_MARKDOWN");
  });

  it("危险条目名（../x.md）→ ZIP_INVALID，透传中文说明", () => {
    const zip = rawStoredZip([
      { name: "../x.md", data: Buffer.from("# evil") },
    ]);
    const err = expectHttpError(() => unpackImportZip(zip), "ZIP_INVALID");
    expect(err.message).toContain("../x.md");
    expect(err.message).toContain("不安全");
  });

  it("非 zip / 损坏 zip → ZIP_INVALID", async () => {
    expectHttpError(
      () => unpackImportZip(Buffer.from("这不是一个zip文件")),
      "ZIP_INVALID",
    );
    const zip = Buffer.from(
      await zipOf([
        { name: "a.md", data: Buffer.from("# a".repeat(200), "utf8") },
      ]),
    );
    // 翻转压缩数据区首字节（本地头 30 + 名 4 = 34 起即数据）→ 解压 / CRC 必败
    zip[35] = (zip[35] as number) ^ 0xff;
    expectHttpError(() => unpackImportZip(zip), "ZIP_INVALID");
  });

  it("条目数超过 300 → ZIP_TOO_LARGE（中文提示带数量）", async () => {
    const files = Array.from(
      { length: ZIP_IMPORT_MAX_ENTRIES + 1 },
      (_, i) => ({
        name: `f${i}.md`,
        data: Buffer.from(`# ${i}`, "utf8"),
      }),
    );
    const zip = await zipOf(files);
    const err = expectHttpError(() => unpackImportZip(zip), "ZIP_TOO_LARGE");
    expect(err.message).toContain("301");
  });

  it("单条目超过 5MB → ZIP_TOO_LARGE（提示带条目名）", async () => {
    const zip = await zipOf([
      { name: "a.md", data: Buffer.from("# a", "utf8") },
      { name: "big.png", data: Buffer.alloc(5 * 1024 * 1024 + 1, 1) },
    ]);
    const err = expectHttpError(() => unpackImportZip(zip), "ZIP_TOO_LARGE");
    expect(err.message).toContain("big.png");
  });

  it("解压后合计超过 48MB → ZIP_TOO_LARGE（全零数据压缩率再高也按解压体积算）", async () => {
    const fiveMb = Buffer.alloc(5 * 1024 * 1024, 0); // 单条目恰在 5MB 限内
    const zip = await zipOf([
      { name: "a.md", data: Buffer.from("# a", "utf8") },
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `img/z${i}.png`,
        data: fiveMb,
      })),
    ]);
    const err = expectHttpError(() => unpackImportZip(zip), "ZIP_TOO_LARGE");
    expect(err.message).toContain("48 MB");
  });
});

// ---------- 配对纯函数 ----------

describe("basenameOf / isExternalSrc", () => {
  it("basename 兼容 / 与 \\", () => {
    expect(basenameOf("a/b/c.png")).toBe("c.png");
    expect(basenameOf("a\\b\\c.png")).toBe("c.png");
    expect(basenameOf("c.png")).toBe("c.png");
  });

  it("外链判定：scheme / 协议相对是外链，盘符与相对路径不是", () => {
    expect(isExternalSrc("https://a.com/x.png")).toBe(true);
    expect(isExternalSrc("http://a.com/x.png")).toBe(true);
    expect(isExternalSrc("data:image/png;base64,xx")).toBe(true);
    expect(isExternalSrc("//cdn.a.com/x.png")).toBe(true);
    expect(isExternalSrc("C:\\pics\\x.png")).toBe(false);
    expect(isExternalSrc("blobs/media/x.png")).toBe(false);
    expect(isExternalSrc("fig1.png")).toBe(false);
  });
});

describe("extractImageRefs", () => {
  it("提取任意形态 src，跨 md 去重保序", () => {
    const refs = extractImageRefs([
      '前文\n::image{src="fig1.png"}\n::image{alt="图" src="pics/fig2.jpg"}',
      '复用同一张 ::image{src="fig1.png"}；外链 ::image{src="https://a/x.png"}',
    ]);
    expect(refs).toEqual(["fig1.png", "pics/fig2.jpg", "https://a/x.png"]);
  });

  it("属性行内才匹配：跨行属性不提取（提取是纯正则形态匹配，行内代码同样计入）", () => {
    const md = [
      '::image{alt="跨行', // 属性被换行截断 → 不匹配
      'src="nope.png"}',
      "",
      '示例 `::image{src="code.png"}` 计入（lint 层负责语义，提取层只认形态）',
    ].join("\n");
    const refs = extractImageRefs([md]);
    expect(refs).toEqual(["code.png"]);
  });
});

describe("pairImageRefs：三规则与冲突", () => {
  it("① 相对路径精确匹配优先（同名多候选下精确命中仍配对）", () => {
    const pairing = pairImageRefs(
      ["a/fig.png", "fig.png"],
      ["a/fig.png", "b/fig.png"],
    );
    expect(pairing.pairs.get("a/fig.png")).toBe("a/fig.png"); // 精确
    expect(pairing.pairs.has("fig.png")).toBe(false); // basename 双候选 → 冲突
    expect(pairing.conflicts).toEqual([{ src: "fig.png", name: "fig.png" }]);
    expect(pairing.unmatched).toEqual([]);
  });

  it("② basename 全局唯一匹配（src 带目录前缀、条目在另一目录）", () => {
    const pairing = pairImageRefs(
      ["blobs/media/fig1.png"],
      ["资料夹/fig1.png"],
    );
    expect(pairing.pairs.get("blobs/media/fig1.png")).toBe("资料夹/fig1.png");
  });

  it("③ basename 多候选 → 冲突不配对；无匹配 → 未配对", () => {
    const pairing = pairImageRefs(
      ["dup.png", "missing.png"],
      ["x/dup.png", "y/dup.png", "other.png"],
    );
    expect(pairing.pairs.size).toBe(0);
    expect(pairing.conflicts).toEqual([{ src: "dup.png", name: "dup.png" }]);
    expect(pairing.unmatched).toEqual(["missing.png"]);
  });

  it("外链 URL 不参与匹配，直接归未配对", () => {
    const pairing = pairImageRefs(
      ["https://a/x.png", "//cdn/x.png"],
      ["x.png"],
    );
    expect(pairing.unmatched).toEqual(["https://a/x.png", "//cdn/x.png"]);
    expect(pairing.pairs.size).toBe(0);
  });

  it("多个不同 src 可配到同一条目（精确 + basename 双路径引用）", () => {
    const pairing = pairImageRefs(["img/fig.png", "fig.png"], ["img/fig.png"]);
    expect(pairing.pairs.get("img/fig.png")).toBe("img/fig.png");
    expect(pairing.pairs.get("fig.png")).toBe("img/fig.png");
  });
});

describe("rewriteImageSrcs", () => {
  const md = [
    "---",
    "kind: lecture",
    "---",
    "",
    "# 讲义",
    "",
    '::image{alt="图A" src="fig1.png" width="300"}',
    "",
    '::image{src="fig1.png"}', // 同 src 第二次出现也改写
    "",
    '::image{src="keep.png"}', // 未在改写表 → 原样
    "",
    '正文 $100 与 `code` 不动：::other{src="fig1.png"}',
  ].join("\n");

  it("只改写配对 src 的引号内值，其余逐字节不变", () => {
    const rewrites = new Map([["fig1.png", "blobs/media/abc.png"]]);
    const out = rewriteImageSrcs(md, rewrites);
    expect(out).toContain(
      '::image{alt="图A" src="blobs/media/abc.png" width="300"}',
    );
    expect(out).toContain('::image{src="blobs/media/abc.png"}');
    expect(out).toContain('::image{src="keep.png"}');
    // 非 ::image 指令不受影响
    expect(out).toContain('::other{src="fig1.png"}');
    expect(out).toContain("正文 $100 与 `code` 不动");
    // 除两处 src 值外逐字节一致（ needles 均含完整指令形态，不误伤 ::other）
    const expected = md
      .replace(
        '::image{alt="图A" src="fig1.png" width="300"}',
        '::image{alt="图A" src="blobs/media/abc.png" width="300"}',
      )
      .replace('::image{src="fig1.png"}', '::image{src="blobs/media/abc.png"}');
    expect(out).toBe(expected);
  });

  it("空改写表原样返回（引用计数一致）", () => {
    expect(rewriteImageSrcs(md, new Map())).toBe(md);
  });

  it("函数式替换：改写值含 $ 亦按字面落盘", () => {
    const out = rewriteImageSrcs(
      '::image{src="a.png"}',
      new Map([["a.png", "$&x$.png"]]),
    );
    expect(out).toBe('::image{src="$&x$.png"}');
  });
});
