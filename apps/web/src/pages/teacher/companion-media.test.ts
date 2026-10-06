import { describe, expect, it } from "vitest";
import { extractImageRefs } from "@/features/markdown/image-refs";
import {
  basenameOf,
  type CompanionCandidate,
  isExternalSrc,
  pairImageRefs,
  rewriteImageSrcs,
} from "./companion-media";

/**
 * 导入随行图片纯函数测试（配对四情形 + 同图多 md 去重 + 改写只动 src 值）。
 * 用户工作流背景：本地 blobs/media/ 里是 AI 起的 64 位十六进制文件名，与内容
 * 真实 sha256 不一致，md 以这些名字引用图片——配对/改写见技术架构 §5.2。
 */

/** 服务端返回形态的 src 夹具（64 位 hex + 扩展名） */
const SERVER_SRC =
  "blobs/media/1111111111111111111111111111111111111111111111111111111111111111.png";

function candidate(path: string, size = 1024): CompanionCandidate {
  return { path, name: basenameOf(path), size };
}

describe("extractImageRefs（任意文件名形态，去重保序）", () => {
  it("提取多份 md 的 ::image src 并跨文档去重（同图多 md 只留一份）", () => {
    const mdA =
      '::image{src="blobs/media/6a485990111111111111111111111111111111111111111111111111111111f.jpg"}\n::image{alt="第二张" src="配图二.png"}';
    const mdB =
      '::image{src="blobs/media/6a485990111111111111111111111111111111111111111111111111111111f.jpg"}';
    expect(extractImageRefs([mdA, mdB])).toEqual([
      "blobs/media/6a485990111111111111111111111111111111111111111111111111111111f.jpg",
      "配图二.png",
    ]);
  });

  it("同一文档内多次引用同一 src 只收集一次；非 ::image 指令与空 src 不收", () => {
    const md = [
      '::image{src="a.png"}',
      '::image{width="60%" src="a.png"}',
      '::image{src=""}',
      ":::tip",
      '内容里的字面 src="b.png" 不在指令里',
      ":::",
      '::video{src="c.mp4"}',
    ].join("\n");
    expect(extractImageRefs([md])).toEqual(["a.png"]);
  });

  it("外链 URL 也算引用（配对阶段归类为不可配对，lint 另行警告）", () => {
    const md = '::image{src="https://example.com/a.png"}';
    expect(extractImageRefs([md])).toEqual(["https://example.com/a.png"]);
  });

  it("attrs 含 src 前后其他属性均可命中；值内不含引号/花括号", () => {
    const md = '::image{alt="示意图" width="60%" src="图/子目录/b.webp"}';
    expect(extractImageRefs([md])).toEqual(["图/子目录/b.webp"]);
  });
});

describe("pairImageRefs（配对规则四情形）", () => {
  it("① src 与所选文件相对路径完全一致优先", () => {
    const result = pairImageRefs(
      ["blobs/media/x.jpg"],
      [candidate("blobs/media/x.jpg"), candidate("别的目录/x.jpg")],
    );
    expect(result.pairs.get("blobs/media/x.jpg")).toBe("blobs/media/x.jpg");
    expect(result.conflicts).toHaveLength(0);
  });

  it("② 路径不完全一致时按 basename 唯一匹配（文件夹选择带根目录前缀的常态）", () => {
    const result = pairImageRefs(
      ["blobs/media/6a48.jpg"],
      [
        candidate("考研学习/blobs/media/6a48.jpg"),
        candidate("考研学习/封面.png"),
      ],
    );
    expect(result.pairs.get("blobs/media/6a48.jpg")).toBe(
      "考研学习/blobs/media/6a48.jpg",
    );
  });

  it("③ basename 命中多个候选 → 冲突不配对（记录 src 与同名）", () => {
    const result = pairImageRefs(
      ["blobs/media/img.jpg"],
      [candidate("章节一/img.jpg", 100), candidate("章节二/img.jpg", 200)],
    );
    expect(result.pairs.size).toBe(0);
    expect(result.conflicts).toEqual([
      { src: "blobs/media/img.jpg", name: "img.jpg" },
    ]);
    expect(result.unmatched).toHaveLength(0);
  });

  it("④ 无匹配文件 → 未配对（不改写，交服务端警告兜底）；外链同样未配对", () => {
    const result = pairImageRefs(
      ["blobs/media/没有这张.jpg", "https://example.com/a.png"],
      [candidate("别的.png")],
    );
    expect(result.pairs.size).toBe(0);
    expect(result.unmatched).toEqual([
      "blobs/media/没有这张.jpg",
      "https://example.com/a.png",
    ]);
  });

  it("多份 md 引用同一张图（不同 src 写法）→ 各自配到同一文件，上传侧按文件去重", () => {
    const result = pairImageRefs(
      ["blobs/media/共享.jpg", "共享.jpg"],
      [candidate("blobs/media/共享.jpg")],
    );
    // 裸文件名按 basename 命中同一文件；带目录前缀的走精确匹配
    expect(result.pairs.get("blobs/media/共享.jpg")).toBe(
      "blobs/media/共享.jpg",
    );
    expect(result.pairs.get("共享.jpg")).toBe("blobs/media/共享.jpg");
    expect(new Set(result.pairs.values())).toEqual(
      new Set(["blobs/media/共享.jpg"]),
    );
  });

  it("未被引用的所选文件不产生任何配对（只上传被引用到的图片）", () => {
    const result = pairImageRefs(
      ["a.png"],
      [
        candidate("a.png"),
        candidate("未引用.png"),
        candidate("子目录/也未引用.png"),
      ],
    );
    expect([...result.pairs.values()]).toEqual(["a.png"]);
  });
});

describe("rewriteImageSrcs（只动配对成功的 src 值）", () => {
  it("仅替换 src 引号内的值：alt/width 与其余内容逐字节不变", () => {
    const md = [
      "# 讲义标题",
      "",
      '::image{alt="示意图" width="60%" src="blobs/media/本地名.jpg"}',
      "",
      "正文段落 $x^2$ 保持原样（含 $ 与反斜杠 \\）。",
      '::image{src="另一张.png"}',
    ].join("\n");
    const out = rewriteImageSrcs(
      md,
      new Map([
        ["blobs/media/本地名.jpg", SERVER_SRC],
        [
          "另一张.png",
          "blobs/media/2222222222222222222222222222222222222222222222222222222222222222.gif",
        ],
      ]),
    );
    expect(out).toBe(
      [
        "# 讲义标题",
        "",
        `::image{alt="示意图" width="60%" src="${SERVER_SRC}"}`,
        "",
        "正文段落 $x^2$ 保持原样（含 $ 与反斜杠 \\）。",
        '::image{src="blobs/media/2222222222222222222222222222222222222222222222222222222222222222.gif"}',
      ].join("\n"),
    );
  });

  it("未配对的 src 不动；同一 src 多处出现全部改写", () => {
    const md = [
      '::image{src="a.jpg"}',
      '::image{src="没配上的.jpg"}',
      '::image{src="a.jpg"}',
    ].join("\n");
    const out = rewriteImageSrcs(md, new Map([["a.jpg", SERVER_SRC]]));
    expect(out).toBe(
      [
        `::image{src="${SERVER_SRC}"}`,
        '::image{src="没配上的.jpg"}',
        `::image{src="${SERVER_SRC}"}`,
      ].join("\n"),
    );
  });

  it("空改写表原样返回；不含 ::image 的文本不受影响", () => {
    const md = '::image{src="a.jpg"}\n普通文本';
    expect(rewriteImageSrcs(md, new Map())).toBe(md);
    expect(rewriteImageSrcs("普通文本", new Map([["a.jpg", SERVER_SRC]]))).toBe(
      "普通文本",
    );
  });

  it("src 值里出现正则元字符也按字面匹配（捕获组当数据不当模式）", () => {
    const md = '::image{src="图 (1)$+.jpg"}';
    const out = rewriteImageSrcs(md, new Map([["图 (1)$+.jpg", SERVER_SRC]]));
    expect(out).toBe(`::image{src="${SERVER_SRC}"}`);
  });
});

describe("isExternalSrc / basenameOf", () => {
  it("http/https/data 协议与 // 开头判为外链；普通路径与 Windows 分隔符不是", () => {
    expect(isExternalSrc("https://a.com/x.png")).toBe(true);
    expect(isExternalSrc("http://a.com/x.png")).toBe(true);
    expect(isExternalSrc("data:image/png;base64,xxxx")).toBe(true);
    expect(isExternalSrc("//cdn.a.com/x.png")).toBe(true);
    expect(isExternalSrc("blobs/media/x.jpg")).toBe(false);
    expect(isExternalSrc("C:\\图\\x.jpg")).toBe(false);
  });

  it("basenameOf 兼容 / 与 \\ 分隔符，无分隔符原样返回", () => {
    expect(basenameOf("a/b/c.png")).toBe("c.png");
    expect(basenameOf("a\\b\\c.png")).toBe("c.png");
    expect(basenameOf("c.png")).toBe("c.png");
  });
});
