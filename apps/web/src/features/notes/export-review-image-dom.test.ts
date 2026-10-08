import type { ReviewPackPreviewData } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyPngBlobToClipboard,
  exportReviewImages,
} from "./export-review-image";

/**
 * T6R.19 合成图导出——栅格化适配器层失败测试（任务清单失败语义逐项）：
 * - 隐藏答案节点不进渲染树：学生角色哨兵命中即拒绝（不建离屏 DOM）；正常
 *   学生载荷渲染出的页面 outerHTML 不含答案哨兵，也不是 display:none 式隐藏；
 *   教师角色按 T6R.13 既有投影照常包含参考答案；
 * - 字体/媒体失败：collectFontCss / loadImages 失败 → 显式中文错误，不下载；
 * - 编码空 Blob：空 Blob / 非 PNG 魔数 / 整页空白 → encode 错误，不落盘；
 * - 过大画布：注入测量高度使单块超画布兜底上限 → canvas-limit 显式失败；
 * - 多页：注入测量高度驱动分页 → 逐页下载、文件名 -01/-02 递增；
 * - 失败语义总则：任何失败路径 savePng 零调用（绝不下载空白图后显示成功）；
 * - 无剪贴板：copyPngBlobToClipboard 在无 clipboard/ClipboardItem 环境返回
 *   false（不崩溃、不谎报成功）。
 *
 * jsdom 无布局与 canvas：测量高度与栅格化全部经 ReviewImageExportDeps 注入
 * （生产缺省实现走真实 DOM 测量与 html-to-image，由 E2E 覆盖）。
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 内容非全零的合法 PNG 形状 Blob（过魔数与非空校验） */
function fakePngBlob(bytes = 256): Blob {
  const arr = new Uint8Array(bytes);
  arr.set(PNG_MAGIC, 0);
  for (let i = 8; i < bytes; i += 1) arr[i] = (i * 31) & 0xff;
  return new Blob([arr], { type: "image/png" });
}

const STUDENT_PREVIEW: ReviewPackPreviewData = {
  role: "student",
  questionNo: 3,
  questionPresent: true,
  handwritten: false,
  evidenceState: "frozen",
  released: true,
  answersIncluded: false,
  complete: true,
  files: [],
  missing: [],
  attachments: [
    {
      path: "evidence/e001-original-01.png",
      kind: "evidence",
      state: "ready",
      bytes: 4096,
      downloadUrl: "/api/student/note-versions/v1/images/i1.png",
    },
  ],
  reviewMd: "",
  questionMd: "### 题目 3\n\n已知 $x+1=4$，求 $x$。\n\n**学生答案**：3\n",
};

/** 全注入成功依赖（栅格化返回合法 PNG、不空白、记录下载与页 DOM） */
function okDeps(spies: {
  rasterizedHtml: string[];
  saved: Array<{ filename: string; bytes: number }>;
  heights?: (count: number) => number[];
}) {
  return {
    collectFontCss: async () => "@font-face { font-family: fake; }",
    loadImages: async () => {},
    rasterizeNode: async (node: HTMLElement) => {
      spies.rasterizedHtml.push(node.outerHTML);
      return fakePngBlob();
    },
    samplePngBlank: async () => false,
    savePng: (blob: Blob, filename: string) => {
      spies.saved.push({ filename, bytes: blob.size });
    },
    ...(spies.heights !== undefined
      ? { measureBlockHeights: (count: number) => spies.heights?.(count) ?? [] }
      : {}),
  };
}

/** 清掉上轮用例可能残留在 body 里的离屏宿主 */
afterEach(() => {
  for (const host of document.querySelectorAll("[data-review-image-host]")) {
    host.remove();
  }
});

/** 由行内样式推导内容宽（边框盒宽 − 左右内边距；两个容器都声明 border-box） */
function inlineContentWidthOf(node: HTMLElement): number {
  return (
    Number.parseFloat(node.style.width) -
    Number.parseFloat(node.style.paddingLeft || "0") -
    Number.parseFloat(node.style.paddingRight || "0")
  );
}

describe("exportReviewImages（测量与渲染同几何——审查修复轮 P0-1/P1-2 回归）", () => {
  it("测量容器与页容器内容宽一致：同为 648（720 边框盒 − 左右留白 36×2）", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
    };
    let measurementContent: HTMLElement | null = null;
    let pageNode: HTMLElement | null = null;
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      rasterizeNode: async (node: HTMLElement) => {
        // 栅格化时离屏宿主仍在文档中：测量容器与页容器可同时取样
        measurementContent ??= document.querySelector<HTMLElement>(
          "[data-export-content]",
        );
        pageNode ??= node;
        spies.rasterizedHtml.push(node.outerHTML);
        return fakePngBlob();
      },
    });
    expect(result.ok).toBe(true);
    expect(measurementContent).not.toBeNull();
    expect(pageNode).not.toBeNull();
    // 页容器：720 边框盒 − padding 36×2 = 648 内容宽（跨行段落换行口径基准）
    expect(inlineContentWidthOf(pageNode as HTMLElement)).toBe(648);
    // 测量容器必须同几何——否则 648 宽下换行更多的段落在 720 宽下测量高度
    // 偏小，每页底部内容被 foreignObject 视口裁剪丢失（P0-1）
    expect(inlineContentWidthOf(measurementContent as HTMLElement)).toBe(648);
    expect(measurementContent?.style.boxSizing).toBe("border-box");
    expect(pageNode?.style.boxSizing).toBe("border-box");
  });

  it("页首块 margin-top 归零：每页第一个块行内 marginTop=0（BFC 口径与测量口径一致）", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
      // 每块 900：两块即 1800 > 1500 → 每块独立成页（多页才有页首块语义）
      heights: (count: number) => Array.from({ length: count }, () => 900),
    };
    const firstBlockMargins: string[] = [];
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      rasterizeNode: async (node: HTMLElement) => {
        const first = node.firstElementChild as HTMLElement | null;
        firstBlockMargins.push(first?.style.marginTop ?? "(缺失)");
        return fakePngBlob();
      },
    });
    expect(result.ok).toBe(true);
    expect(firstBlockMargins.length).toBeGreaterThanOrEqual(2);
    for (const margin of firstBlockMargins) {
      // 测量容器的块高差（offsetTop delta）不含块自身 margin-top；页容器
      // flow-root 的 BFC 全额包含页首块 margin——不归零每页多溢出 8–14px（P1-2）
      expect(margin).toBe("0px");
    }
  });
});

describe("exportReviewImages（适配器层：成功与清理）", () => {
  it("学生载荷单页成功：页 DOM 含题面与学生答案、下载一次、离屏宿主清理", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
    };
    const result = await exportReviewImages(STUDENT_PREVIEW, okDeps(spies));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.filename).toBe("review-image-q3-student-01.png");
    expect(spies.saved).toHaveLength(1);
    expect(spies.saved[0]?.filename).toBe("review-image-q3-student-01.png");
    // 页 DOM：题面与学生答案在场（KaTeX 注解里保留原始 LaTeX）
    const pageHtml = spies.rasterizedHtml[0] ?? "";
    expect(pageHtml).toContain("学生答案");
    expect(pageHtml).toContain("x+1=4");
    // markdown 逐段拆块（h3 + 两个 p → ≥3 个 md 块壳）——长题干才能分页
    // （回归：曾整段成一块，长题干恒超画布兜底上限）
    expect(
      (pageHtml.match(/data-export-md-block/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    // 导出后离屏宿主已移除（不留悬挂 DOM）
    expect(document.querySelectorAll("[data-review-image-host]").length).toBe(
      0,
    );
  });

  it("多页：注入测量高度驱动分页 → 逐页下载、文件名 -01/-02 递增", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
      // 每块 900：两块即 1800 > 1500 → 每块独立成页
      heights: (count: number) => Array.from({ length: count }, () => 900),
    };
    const result = await exportReviewImages(STUDENT_PREVIEW, okDeps(spies));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    expect(result.pages.map((p) => p.filename)).toEqual(
      result.pages.map(
        (_, i) =>
          `review-image-q3-student-${String(i + 1).padStart(2, "0")}.png`,
      ),
    );
    expect(spies.saved).toHaveLength(result.pages.length);
  });
});

describe("exportReviewImages（隐藏答案不进渲染树）", () => {
  it("学生载荷哨兵命中：拒绝生成（kind=forbidden），不建 DOM、零下载", async () => {
    const rasterize = vi.fn(async () => fakePngBlob());
    const savePng = vi.fn();
    const result = await exportReviewImages(
      {
        ...STUDENT_PREVIEW,
        questionMd: "### 题目 3\n\n填空：x=[[二]]。\n",
      },
      {
        collectFontCss: async () => "",
        loadImages: async () => {},
        rasterizeNode: rasterize,
        samplePngBlank: async () => false,
        savePng,
        measureBlockHeights: (count) =>
          Array.from({ length: count }, () => 100),
      },
    );
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "forbidden" }),
    });
    expect(rasterize).not.toHaveBeenCalled();
    expect(savePng).not.toHaveBeenCalled();
  });

  it("正常学生载荷：页面 outerHTML 不含答案哨兵，页面本身可见（非 display:none 隐藏）", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
    };
    await exportReviewImages(STUDENT_PREVIEW, okDeps(spies));
    const html = spies.rasterizedHtml[0] ?? "";
    // 哨兵：教师模板节标记与解析原文（答案内容根本不进渲染树）
    expect(html).not.toContain("**参考答案**");
    expect(html).not.toContain("故选");
    expect(html).not.toContain("[[二]]");
    // 学生自己的内容在场——不是靠隐藏节点"装出来"的不含
    expect(html).toContain("学生答案");
  });

  it("教师载荷：照常包含参考答案/详解（T6R.13 既有投影），导出成功", async () => {
    const spies = {
      rasterizedHtml: [] as string[],
      saved: [] as Array<{ filename: string; bytes: number }>,
    };
    const result = await exportReviewImages(
      {
        ...STUDENT_PREVIEW,
        role: "teacher",
        answersIncluded: true,
        questionMd:
          "### 题目 3\n\n题面。\n\n**参考答案**：B\n\n**详解**\n\n故选 B。\n",
      },
      okDeps(spies),
    );
    expect(result.ok).toBe(true);
    expect(spies.rasterizedHtml[0]).toContain("参考答案");
    expect(spies.rasterizedHtml[0]).toContain("故选 B");
    if (result.ok) {
      expect(result.pages[0]?.filename).toBe("review-image-q3-teacher-01.png");
    }
  });
});

describe("exportReviewImages（失败语义：显式中文错误 + 零下载）", () => {
  const baseSpies = () => ({
    rasterizedHtml: [] as string[],
    saved: [] as Array<{ filename: string; bytes: number }>,
    heights: (count: number) => Array.from({ length: count }, () => 100),
  });

  it("字体嵌入失败：kind=font、中文原因、零下载、宿主清理", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      collectFontCss: () => Promise.reject(new Error("stylesheet 不可读")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("font");
    expect(result.error.message).toContain("字体");
    expect(spies.saved).toHaveLength(0);
    expect(document.querySelectorAll("[data-review-image-host]").length).toBe(
      0,
    );
  });

  it("图片加载失败：kind=media、中文原因、零下载", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      loadImages: () =>
        Promise.reject(
          new Error(
            "图片加载失败：/api/student/note-versions/v1/images/i1.png",
          ),
        ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("media");
    expect(result.error.message).toContain("图片");
    expect(spies.saved).toHaveLength(0);
  });

  it("编码空 Blob：kind=encode、零下载（不下载空白/残缺文件）", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      rasterizeNode: async () => new Blob([], { type: "image/png" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
    expect(spies.saved).toHaveLength(0);
  });

  it("编码产物非 PNG 魔数：kind=encode、零下载", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      rasterizeNode: async () =>
        new Blob([new TextEncoder().encode("not a png at all..........")], {
          type: "image/png",
        }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
    expect(spies.saved).toHaveLength(0);
  });

  it("整页空白（字体/渲染失败产白图）：kind=encode、中文原因、零下载", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      samplePngBlank: async () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("encode");
    expect(result.error.message).toContain("空白");
    expect(spies.saved).toHaveLength(0);
  });

  it("单块超画布兜底上限（分页兜底仍超限）：kind=canvas-limit、零下载", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      measureBlockHeights: (count) => {
        const heights = Array.from({ length: count }, () => 100);
        if (heights.length > 1) heights[1] = 5000; // 单块 5000px 超兜底上限 1976
        return heights;
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("canvas-limit");
    expect(result.error.message).toContain("画布");
    expect(spies.saved).toHaveLength(0);
  });

  it("栅格化本体抛错：kind=rasterize、中文原因、零下载", async () => {
    const spies = baseSpies();
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...okDeps(spies),
      rasterizeNode: () => Promise.reject(new Error("boom")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rasterize");
    expect(result.error.message).toContain("栅格化");
    expect(spies.saved).toHaveLength(0);
  });
});

describe("exportReviewImages（异步步骤超时：挂起转分类失败，绝不永久 loading）", () => {
  /** 永不 settle 的 Promise（模拟 iOS/旧 WebKit decode()/canvas 挂起怪癖） */
  const never = <T>(): Promise<T> => new Promise<T>(() => {});

  /** 注入 50ms 短超时（真实定时器——React 提交走 MessageChannel，假定时器推进不到） */
  const fastTimeout = { stepTimeoutMs: 50 } as const;

  it("字体收集挂起：超时转 font 失败（中文原因含超时）、零下载", async () => {
    const saved: Array<{ filename: string; bytes: number }> = [];
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...fastTimeout,
      collectFontCss: () => never<string>(),
      loadImages: async () => {},
      rasterizeNode: async () => fakePngBlob(),
      samplePngBlank: async () => false,
      savePng: (blob, filename) => saved.push({ filename, bytes: blob.size }),
      measureBlockHeights: (count) => Array.from({ length: count }, () => 100),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("font");
    expect(result.error.message).toContain("超时");
    expect(saved).toHaveLength(0);
  });

  it("图片预解码挂起：超时转 media 失败（不进渲染）、零下载", async () => {
    const rasterize = vi.fn(async () => fakePngBlob());
    const saved: Array<{ filename: string; bytes: number }> = [];
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...fastTimeout,
      collectFontCss: async () => "",
      loadImages: () => never<void>(),
      rasterizeNode: rasterize,
      samplePngBlank: async () => false,
      savePng: (blob, filename) => saved.push({ filename, bytes: blob.size }),
      measureBlockHeights: (count) => Array.from({ length: count }, () => 100),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("media");
    expect(result.error.message).toContain("超时");
    expect(rasterize).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("栅格化挂起：超时转 rasterize 失败、零下载", async () => {
    const saved: Array<{ filename: string; bytes: number }> = [];
    const result = await exportReviewImages(STUDENT_PREVIEW, {
      ...fastTimeout,
      collectFontCss: async () => "",
      loadImages: async () => {},
      rasterizeNode: () => never<Blob>(),
      samplePngBlank: async () => false,
      savePng: (blob, filename) => saved.push({ filename, bytes: blob.size }),
      measureBlockHeights: (count) => Array.from({ length: count }, () => 100),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rasterize");
    expect(result.error.message).toContain("超时");
    expect(saved).toHaveLength(0);
  });
});

describe("copyPngBlobToClipboard（无剪贴板降级，不崩溃不谎报）", () => {
  it("clipboard/ClipboardItem 不可用（HTTP 部署等）：返回 false、不抛错", async () => {
    // jsdom 默认无 navigator.clipboard 与 ClipboardItem——即目标降级环境
    expect(
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem,
    ).toBeUndefined();
    await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(false);
  });

  it("clipboard.write 拒绝：返回 false（不谎报已复制）", async () => {
    const write = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    class FakeClipboardItem {
      constructor(public readonly items: Map<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    try {
      await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  });

  it("clipboard.write 成功：返回 true", async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    class FakeClipboardItem {
      constructor(public readonly items: Map<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    try {
      await expect(copyPngBlobToClipboard(fakePngBlob())).resolves.toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  });
});
