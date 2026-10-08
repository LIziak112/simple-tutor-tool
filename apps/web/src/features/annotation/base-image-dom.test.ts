import type { AnnotationBasePreviewData } from "@tutor/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS,
  renderAnnotationBaseImage,
} from "./base-image";

/**
 * T6R.20 底图生成管线——栅格化适配器层测试（jsdom 无布局/canvas：测量与
 * 栅格化经 AnnotationBaseRenderDeps 注入，生产链路由 E2E 覆盖）：
 * - 成功：单张 PNG（无分页）、页面 DOM 含题面/不含答案哨兵、rasterizeNode
 *   收到的像素宽恒 1440；
 * - 超高题：注入测量高超 1976 → too-tall 显式禁用原因（含「草稿」照用口径）；
 * - 失败语义：字体/图片/编码（空 Blob/非 PNG 魔数/空白）各分类显式中文错误；
 * - ::image 媒体预解码走 mediaSrcs（真实图片进底图，不是附件指引占位）。
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 内容非全零的合法 PNG 形状 Blob */
function fakePngBlob(bytes = 256): Blob {
  const arr = new Uint8Array(bytes);
  arr.set(PNG_MAGIC, 0);
  for (let i = 8; i < bytes; i += 1) arr[i] = (i * 31) & 0xff;
  return new Blob([arr], { type: "image/png" });
}

function previewOf(
  overrides: Partial<AnnotationBasePreviewData> = {},
): AnnotationBasePreviewData {
  return {
    base: {
      baseId: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      stale: false,
      pixelWidth: null,
      pixelHeight: null,
    },
    baseRenderVersion: 1,
    maxWidthPx: 1440,
    questionRevisionId: "b-00000000-0000-4000-8000-000000000001",
    questionNo: 1,
    questionMd: "### 题目\n\n已知 $x+1=4$，求 $x$。\n",
    mediaSrcs: [],
    graphFigures: [],
    interactionNotes: [],
    ...overrides,
  } as AnnotationBasePreviewData;
}

interface Spies {
  rasterizedHtml: string[];
  rasterOpts: Array<{ pixelWidth: number; pixelHeight: number }>;
  imageUrls: string[][];
  heights?: (count: number) => number[];
}

/** 全注入成功依赖 */
function okDeps(spies: Spies) {
  return {
    collectFontCss: async () => "@font-face { font-family: fake; }",
    loadImages: async (urls: readonly string[]) => {
      spies.imageUrls.push([...urls]);
    },
    rasterizeNode: async (
      node: HTMLElement,
      opts: { pixelWidth: number; pixelHeight: number },
    ) => {
      spies.rasterizedHtml.push(node.outerHTML);
      spies.rasterOpts.push(opts);
      return fakePngBlob();
    },
    samplePngBlank: async () => false,
    ...(spies.heights !== undefined
      ? {
          measureBlockHeights: (count: number) => spies.heights?.(count) ?? [],
        }
      : {}),
  };
}

afterEach(() => {
  for (const host of document.querySelectorAll("[data-annotation-base-host]")) {
    host.remove();
  }
});

describe("renderAnnotationBaseImage（适配器层：成功）", () => {
  it("单页成功：题面在场、不含答案哨兵、像素宽恒 1440、离屏宿主清理", async () => {
    const spies: Spies = {
      rasterizedHtml: [],
      rasterOpts: [],
      imageUrls: [],
      heights: (count) => Array.from({ length: count }, () => 120),
    };
    const result = await renderAnnotationBaseImage(previewOf(), okDeps(spies));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pixelWidth).toBe(1440);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(spies.rasterizedHtml).toHaveLength(1); // 单页（无分页）
    const html = spies.rasterizedHtml[0] ?? "";
    expect(html).toContain("x+1=4");
    expect(html).toContain("题干标注底图");
    expect(html).not.toContain("**参考答案**");
    expect(html).not.toContain("[[二]]");
    // rasterizeNode 收到的像素宽恒 1440（上传侧服务端校验同值）
    expect(spies.rasterOpts[0]?.pixelWidth).toBe(1440);
    // 导出后离屏宿主已移除
    expect(
      document.querySelectorAll("[data-annotation-base-host]").length,
    ).toBe(0);
  });

  it("::image 题面：mediaSrcs 预解码（真实图片进底图，非附件指引占位）", async () => {
    const spies: Spies = {
      rasterizedHtml: [],
      rasterOpts: [],
      imageUrls: [],
      heights: (count) => Array.from({ length: count }, () => 100),
    };
    const result = await renderAnnotationBaseImage(
      previewOf({
        questionMd:
          '### 题目\n\n看图作答。\n\n::image{src="blobs/media/aaaa.png" alt="示意图"}\n',
        mediaSrcs: ["blobs/media/aaaa.png"],
      }),
      okDeps(spies),
    );
    expect(result.ok).toBe(true);
    // 预解码 URL 已归一化为根相对
    expect(spies.imageUrls[0]).toContain("/blobs/media/aaaa.png");
    // 页面 DOM 渲染为真实 img（src 归一化），不是「配图见附件区」占位
    expect(spies.rasterizedHtml[0]).toContain('src="/blobs/media/aaaa.png"');
    expect(spies.rasterizedHtml[0]).not.toContain("附件");
  });
});

describe("renderAnnotationBaseImage（超高题显式禁用）", () => {
  it("内容高超 1976：too-tall 分类、原因含上限与「草稿照用」、不栅格化", async () => {
    const spies: Spies = {
      rasterizedHtml: [],
      rasterOpts: [],
      imageUrls: [],
      heights: (count) => {
        const heights = Array.from({ length: count }, () => 100);
        if (heights.length > 0) heights[0] = 2100;
        return heights;
      },
    };
    const result = await renderAnnotationBaseImage(previewOf(), okDeps(spies));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("too-tall");
    expect(result.error.message).toContain(
      String(ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS),
    );
    expect(result.error.message).toContain("草稿");
    expect(spies.rasterizedHtml).toHaveLength(0); // 不栅格化（显式禁用≠生成残图）
  });
});

describe("renderAnnotationBaseImage（失败语义：显式中文错误）", () => {
  const baseSpies = (): Spies => ({
    rasterizedHtml: [],
    rasterOpts: [],
    imageUrls: [],
    heights: (count) => Array.from({ length: count }, () => 100),
  });

  it("学生载荷哨兵命中：kind=forbidden、零栅格化", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(
      previewOf({ questionMd: "填空：x=[[二]]。\n" }),
      okDeps(spies),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("forbidden");
    expect(spies.rasterizedHtml).toHaveLength(0);
  });

  it("字体嵌入失败：kind=font、中文原因", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(previewOf(), {
      ...okDeps(spies),
      collectFontCss: () => Promise.reject(new Error("stylesheet 不可读")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("font");
    expect(result.error.message).toContain("字体");
  });

  it("配图加载失败：kind=media、中文原因、零栅格化", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(
      previewOf({
        questionMd: "::image{src='blobs/media/bbbb.png'}\n",
        mediaSrcs: ["blobs/media/bbbb.png"],
      }),
      {
        ...okDeps(spies),
        loadImages: () =>
          Promise.reject(new Error("图片加载失败：/blobs/media/bbbb.png")),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("media");
    expect(spies.rasterizedHtml).toHaveLength(0);
  });

  it("编码空 Blob：kind=encode", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(previewOf(), {
      ...okDeps(spies),
      rasterizeNode: async () => new Blob([], { type: "image/png" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
  });

  it("编码产物非 PNG 魔数：kind=encode", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(previewOf(), {
      ...okDeps(spies),
      rasterizeNode: async () =>
        new Blob([new TextEncoder().encode("not a png at all..........")], {
          type: "image/png",
        }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
  });

  it("整页空白：kind=encode、原因含「空白」", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(previewOf(), {
      ...okDeps(spies),
      samplePngBlank: async () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
    expect(result.error.message).toContain("空白");
  });

  it("栅格化本体抛错：kind=rasterize、中文原因", async () => {
    const spies = baseSpies();
    const result = await renderAnnotationBaseImage(previewOf(), {
      ...okDeps(spies),
      rasterizeNode: () => Promise.reject(new Error("boom")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rasterize");
    expect(result.error.message).toContain("栅格化");
  });
});
