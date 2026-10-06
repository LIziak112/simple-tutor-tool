/**
 * 独立渲染器测试（T6R.6）：jsdom 无 2d canvas，本文件用「录制式 2d 上下文桩」
 * 断言渲染器发出的绘制命令流（背景命令、笔迹重放、几何与守卫）；真实像素级
 * 验证（解码 PNG、内容/基准对照）在 Playwright E2E（真 Chromium/WebKit canvas，
 * e2e/note-render.spec.ts + /dev/ink 渲染验证面板）完成——两层互补，取舍说明见
 * 任务报告。
 *
 * 桩的三个关键点：
 * - getContext("2d") → RecordingContext（记录 fillRect/stroke 路径与样式）；
 * - offsetWidth/offsetHeight：jsdom 不做布局恒为 0，而 atrament 5.x 内部用
 *   canvas.offsetWidth 做坐标换算（除数为 0 会得 NaN）——桩从 style.width/height
 *   读回渲染器设置的显式尺寸；
 * - toBlob：可编程（正常字节 / null / 超限字节 / 挂起后手动释放）。
 */

import {
  NOTE_IMAGE_MAX_PIXEL_DIM,
  NOTE_IMAGE_PNG_MAX_BYTES,
  NOTE_RENDER_VERSION,
  type NoteDoc,
  type NoteDocInput,
  noteDocSchema,
} from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INK_HIGHLIGHTER,
  INK_PEN_COLORS,
} from "@/features/ink/engine/types.ts";
import {
  ANALYSIS_PIXEL_WIDTH,
  ANALYSIS_SLICE_HEIGHT_LOGICAL,
  ANALYSIS_SLICE_MAX_PIXELS,
  ANALYSIS_SLICE_OVERLAP_LOGICAL,
  analysisSliceHeightMax,
  inkBBoxLogical,
  NOTE_PAPER_GRID_SPACING_LOGICAL,
  NOTE_PAPER_LINE_COLOR,
  planAnalysisCrop,
  planAnalysisPages,
  planThumbnailPage,
  renderNoteImages,
  renderNotePage,
  sliceCropRects,
  THUMBNAIL_PIXEL_WIDTH,
} from "@/features/notes/render-note.ts";

// ---------- 文档与笔画工厂 ----------

/** 单点（轻点）或折线笔画（契约形状；color 用引擎真实色板值保证保真） */
function stroke(
  points: Array<[number, number]>,
  o: { color?: string; weight?: number; tool?: "pen" | "highlighter" } = {},
) {
  return {
    tool: o.tool ?? "pen",
    color: o.color ?? INK_PEN_COLORS.black,
    weight: o.weight ?? 4,
    points: points.map(([x, y]) => ({ x, y, p: 0.5, t: 0 })),
  };
}

/** 解析为物化默认值的 NoteDoc（读入口径同生产：parse 物化缺省） */
function docOf(
  strokes: NoteDocInput["ink"]["strokes"],
  o: { paperHeightLogical?: number; background?: NoteDoc["background"] } = {},
): NoteDoc {
  return noteDocSchema.parse({
    version: 1,
    ink: { width: 1000, strokes },
    ...(o.paperHeightLogical !== undefined
      ? { paperHeightLogical: o.paperHeightLogical }
      : {}),
    ...(o.background !== undefined ? { background: o.background } : {}),
  });
}

// ---------- 录制式 2d 上下文桩 ----------

/** 一条路径指令（moveTo/lineTo/quadraticCurveTo 的坐标快照） */
interface PathOp {
  op: "moveTo" | "lineTo" | "quadraticCurveTo";
  pts: number[];
}

/** 一次 stroke() 提交的完整快照（样式 + 路径） */
interface StrokeCall {
  style: string;
  lineWidth: number;
  path: PathOp[];
}

class RecordingContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  readonly fills: Array<{
    style: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
  readonly strokeCalls: StrokeCall[] = [];
  #path: PathOp[] = [];

  beginPath(): void {
    this.#path = [];
  }
  moveTo(x: number, y: number): void {
    this.#path.push({ op: "moveTo", pts: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.#path.push({ op: "lineTo", pts: [x, y] });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.#path.push({ op: "quadraticCurveTo", pts: [cx, cy, x, y] });
  }
  closePath(): void {}
  stroke(): void {
    this.strokeCalls.push({
      style: String(this.strokeStyle),
      lineWidth: this.lineWidth,
      path: this.#path,
    });
    this.#path = [];
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ style: String(this.fillStyle), x, y, w, h });
  }
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
}

/** canvas → 其录制上下文（隔离断言：每个渲染页一个独立实例） */
const ctxByCanvas = new WeakMap<HTMLCanvasElement, RecordingContext>();

/** 本测试内按创建顺序出现的 canvas（隔离断言用；afterEach 清空） */
const createdCanvases: HTMLCanvasElement[] = [];

/** toBlob 行为：返回字节串 → 正常；null → 编码失败；"defer" → 挂起待手动释放 */
let toBlobBehavior: (
  canvas: HTMLCanvasElement,
) => Uint8Array<ArrayBuffer> | null | "defer" = () => new Uint8Array([1, 2, 3]);
/** "defer" 模式下待释放的回调（隔离测试用） */
const deferredToBlob: Array<(b: Blob | null) => void> = [];

let getContextSpy: ReturnType<typeof vi.spyOn>;
let toBlobSpy: ReturnType<typeof vi.spyOn>;
const origOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

beforeEach(() => {
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      // 与真实浏览器一致：同一 canvas 的 getContext("2d") 返回同一实例
      const existing = ctxByCanvas.get(this);
      if (existing) return existing as unknown as CanvasRenderingContext2D;
      const rec = new RecordingContext();
      ctxByCanvas.set(this, rec);
      createdCanvases.push(this);
      return rec as unknown as CanvasRenderingContext2D;
    });
  toBlobSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation(function (
      this: HTMLCanvasElement,
      cb: ((b: Blob | null) => void) | null,
    ) {
      const behavior = toBlobBehavior(this);
      if (behavior === "defer") {
        if (cb) deferredToBlob.push(cb);
        return;
      }
      const blob = behavior === null ? null : new Blob([behavior]);
      if (cb) queueMicrotask(() => cb(blob));
    });
  // jsdom 不做布局：从渲染器设置的显式 CSS 尺寸读回 offsetWidth/Height
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.width ?? "") || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.height ?? "") || 0;
    },
  });
});

afterEach(() => {
  getContextSpy.mockRestore();
  toBlobSpy.mockRestore();
  if (origOffsetWidth)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      origOffsetWidth,
    );
  if (origOffsetHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      origOffsetHeight,
    );
  deferredToBlob.length = 0;
  createdCanvases.length = 0;
  toBlobBehavior = () => new Uint8Array([1, 2, 3]);
});

// ---------- 纯几何：包围盒 ----------

describe("inkBBoxLogical：包围盒含线宽", () => {
  it("空稿返回 null", () => {
    expect(inkBBoxLogical(docOf([]).ink)).toBeNull();
  });

  it("单点轻点 weight 4 → 四向各扩半线宽", () => {
    const d = docOf([stroke([[200, 300]])]);
    expect(inkBBoxLogical(d.ink)).toEqual({
      minX: 198,
      minY: 298,
      maxX: 202,
      maxY: 302,
    });
  });

  it("荧光笔 weight 16 → 扩 8 逻辑单位", () => {
    const d = docOf([
      stroke(
        [
          [100, 500],
          [900, 600],
        ],
        {
          tool: "highlighter",
          color: INK_HIGHLIGHTER.color,
          weight: INK_HIGHLIGHTER.weight,
        },
      ),
    ]);
    expect(inkBBoxLogical(d.ink)).toEqual({
      minX: 92,
      minY: 492,
      maxX: 908,
      maxY: 608,
    });
  });
});

// ---------- 纯几何：裁剪与切片计划 ----------

describe("planAnalysisCrop：纵向记录范围 + 网格对齐 + 边界钳制", () => {
  it("笔迹 y∈[500,600]（w4，bbox 498..602）→ pad 48 后网格对齐为 [440,680]", () => {
    const d = docOf([
      stroke([
        [100, 500],
        [900, 600],
      ]),
    ]);
    expect(planAnalysisCrop(d)).toEqual({
      x: 0,
      y: 440,
      width: 1000,
      height: 240,
    });
  });

  it("顶部笔迹：y0 钳制到 0 不为负", () => {
    const d = docOf([
      stroke([
        [100, 5],
        [900, 15],
      ]),
    ]);
    expect(planAnalysisCrop(d)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 80,
    });
  });

  it("底部笔迹：y1 钳制到纸高", () => {
    const d = docOf([
      stroke([
        [100, 780],
        [900, 795],
      ]),
    ]);
    expect(planAnalysisCrop(d)).toEqual({
      x: 0,
      y: 720,
      width: 1000,
      height: 80,
    });
  });

  it("空稿 → 整纸（诚实呈现空纸，是否出图由调用方决定）", () => {
    const d = docOf([], { paperHeightLogical: 1200 });
    expect(planAnalysisCrop(d)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 1200,
    });
  });
});

describe("sliceCropRects：切片顺序/重叠/末页", () => {
  const full = (height: number) => ({
    x: 0,
    y: 0,
    width: 1000,
    height,
  });

  it("不超片高 → 单页原样", () => {
    expect(sliceCropRects(full(ANALYSIS_SLICE_HEIGHT_LOGICAL))).toEqual([
      full(ANALYSIS_SLICE_HEIGHT_LOGICAL),
    ]);
    expect(sliceCropRects(full(100))).toEqual([full(100)]);
  });

  it("3000 高长稿 → 3 页，相邻重叠恰 40，末页覆盖到底", () => {
    const pages = sliceCropRects(full(3000));
    expect(pages.map((p) => [p.y, p.height])).toEqual([
      [0, 1400],
      [1360, 1400],
      [2720, 280],
    ]);
    // 顺序断言：y 单调不减且首尾覆盖整个裁剪区
    expect(pages[0]?.y).toBe(0);
    const last = pages[pages.length - 1];
    expect(last ? last.y + last.height : 0).toBe(3000);
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1];
      const cur = pages[i];
      if (!prev || !cur) throw new Error("unreachable");
      expect(prev.y + prev.height - cur.y).toBe(ANALYSIS_SLICE_OVERLAP_LOGICAL);
    }
  });

  it("非零起点裁剪区同样按重叠推进", () => {
    const pages = sliceCropRects({ x: 0, y: 720, width: 1000, height: 2280 });
    // y=720: [720,2120]；推进 2120-40=2080: [2080,3000]（触底收尾）
    expect(pages.map((p) => [p.y, p.height])).toEqual([
      [720, 1400],
      [2080, 920],
    ]);
  });
});

describe("analysisSliceHeightMax：长边与总像素同时限制", () => {
  it("当前分析宽 1000 → 两约束同时收敛在 1400", () => {
    expect(analysisSliceHeightMax(ANALYSIS_PIXEL_WIDTH)).toBe(1400);
  });

  it("未来提清到 1500 宽时由总像素约束压到 933（renderVersion 递增场景）", () => {
    expect(Math.floor(ANALYSIS_SLICE_MAX_PIXELS / 1500)).toBe(933);
    expect(analysisSliceHeightMax(1500)).toBe(
      Math.min(ANALYSIS_SLICE_HEIGHT_LOGICAL, 933),
    );
  });
});

describe("页面计划：像素尺寸与页号", () => {
  it("缩略图：整纸、宽 480、高等比取整", () => {
    expect(planThumbnailPage(docOf([]))).toEqual({
      pageIndex: 0,
      crop: { x: 0, y: 0, width: 1000, height: 800 },
      pixelWidth: THUMBNAIL_PIXEL_WIDTH,
      pixelHeight: 384,
    });
  });

  it("分析图：pageIndex 从 0 递增；比例 1:1（像素高=逻辑高）；长稿多页", () => {
    const tall = docOf(
      [
        stroke([
          [100, 60],
          [900, 2950],
        ]),
      ],
      {
        paperHeightLogical: 3000,
      },
    );
    const pages = planAnalysisPages(tall);
    expect(pages.length).toBe(3);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    for (const p of pages) {
      expect(p.pixelWidth).toBe(1000);
      expect(p.pixelHeight).toBe(p.crop.height);
      expect(p.crop.x + p.crop.width).toBeLessThanOrEqual(1000);
      expect(p.crop.y + p.crop.height).toBeLessThanOrEqual(3000);
    }
  });
});

// ---------- 渲染：背景进入实际图像（命令流级） ----------

describe("renderNotePage：背景实际绘制进 PNG（白底/格线/横线）", () => {
  it("white：整页白底填充，无任何格线描边", async () => {
    const canvas = await captureCanvas(docOf([], { background: "white" }));
    const ctx = ctxOf(canvas);
    expect(ctx.fills).toContainEqual({
      style: "#ffffff",
      x: 0,
      y: 0,
      w: THUMBNAIL_PIXEL_WIDTH,
      h: 384,
    });
    expect(
      ctx.strokeCalls.filter((s) => s.style === NOTE_PAPER_LINE_COLOR),
    ).toHaveLength(0);
  });

  it("grid：格线颜色出现，且纵向横向都有、间距 40 逻辑（缩略图 s=0.48）", async () => {
    const canvas = await captureCanvas(
      docOf([], { background: "grid", paperHeightLogical: 800 }),
      THUMBNAIL_PIXEL_WIDTH,
    );
    const ctx = ctxOf(canvas);
    const grid = ctx.strokeCalls.filter(
      (s) => s.style === NOTE_PAPER_LINE_COLOR,
    );
    // 800/40 - 1 = 19 条横线；1000/40 - 1 = 24 条竖线
    const hLines = grid.filter((s) => isAxisAligned(s, "h"));
    const vLines = grid.filter((s) => isAxisAligned(s, "v"));
    expect(hLines.length).toBe(19);
    expect(vLines.length).toBe(24);
    // 间距：横线 y 坐标相邻差 = 40 逻辑 × 缩放 0.48（浮点直接比较，容差 0.05px）
    const spacingPx =
      NOTE_PAPER_GRID_SPACING_LOGICAL * (THUMBNAIL_PIXEL_WIDTH / 1000);
    const ys = hLines.map((s) => yOf(s.path)).sort((a, b) => a - b);
    let prevY: number | null = null;
    for (const y of ys) {
      if (prevY !== null) expect(y - prevY).toBeCloseTo(spacingPx, 1);
      prevY = y;
    }
  });

  it("line：只有横线（无竖线）", async () => {
    const canvas = await captureCanvas(docOf([], { background: "line" }));
    const ctx = ctxOf(canvas);
    const grid = ctx.strokeCalls.filter(
      (s) => s.style === NOTE_PAPER_LINE_COLOR,
    );
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.filter((s) => isAxisAligned(s, "v"))).toHaveLength(0);
    expect(grid.every((s) => isAxisAligned(s, "h"))).toBe(true);
  });
});

// ---------- 渲染：笔迹保真 ----------

describe("renderNotePage：笔迹重放（复用引擎原语）", () => {
  it("黑笔画与荧光笔各按真实颜色重放；轻点（单点）也落墨", async () => {
    const d = docOf([
      stroke([
        [100, 100],
        [300, 120],
      ]),
      stroke(
        [
          [150, 90],
          [350, 110],
        ],
        {
          tool: "highlighter",
          color: INK_HIGHLIGHTER.color,
          weight: INK_HIGHLIGHTER.weight,
        },
      ),
      stroke([[500, 200]]),
    ]);
    const canvas = await captureCanvas(d);
    const ctx = ctxOf(canvas);
    const inkStrokes = ctx.strokeCalls.filter(
      (s) => s.style !== NOTE_PAPER_LINE_COLOR,
    );
    const styles = new Set(inkStrokes.map((s) => s.style));
    expect(styles.has(INK_PEN_COLORS.black)).toBe(true);
    expect(styles.has(INK_HIGHLIGHTER.color)).toBe(true);
    // 轻点也产生提交（atrament 对单点 draw(x,y,x,y) 画出墨点）
    expect(inkStrokes.length).toBeGreaterThanOrEqual(3);
  });

  it("擦除后图文一致：擦掉红笔的文档不再重放红色", async () => {
    const withRed = docOf([
      stroke([
        [100, 100],
        [300, 120],
      ]),
      stroke(
        [
          [100, 200],
          [300, 220],
        ],
        { color: INK_PEN_COLORS.red },
      ),
    ]);
    const erased = docOf([
      stroke([
        [100, 100],
        [300, 120],
      ]),
      // 红笔被整笔橡皮删除：strokes 里不再有它
    ]);
    const ctxA = ctxOf(await captureCanvas(withRed));
    const ctxB = ctxOf(await captureCanvas(erased));
    const redIn = (ctx: RecordingContext) =>
      ctx.strokeCalls.some((s) => s.style === INK_PEN_COLORS.red);
    expect(redIn(ctxA)).toBe(true);
    expect(redIn(ctxB)).toBe(false);
  });

  it("最高笔迹含线宽不裁切：荧光笔压在纸顶/底边缘，笔迹点全部落在页内", async () => {
    // 荧光笔 w16：y∈[792,808] → bbox 784..816，纸高 800 → crop [720,800]
    const d = docOf(
      [
        stroke(
          [
            [100, 792],
            [900, 808],
          ],
          {
            tool: "highlighter",
            color: INK_HIGHLIGHTER.color,
            weight: INK_HIGHLIGHTER.weight,
          },
        ),
      ],
      { paperHeightLogical: 800 },
    );
    const plan = planAnalysisPages(d);
    expect(plan).toHaveLength(1);
    const page = plan[0];
    if (!page) throw new Error("单页计划缺失（测试前提不成立）");
    expect(page.crop.y + page.crop.height).toBe(800);
    const ctx = ctxOf(await captureCanvas(d, ANALYSIS_PIXEL_WIDTH, page.crop));
    const hl = ctx.strokeCalls.filter((s) => s.style === INK_HIGHLIGHTER.color);
    expect(hl.length).toBeGreaterThan(0);
    const ys = hl.flatMap((s) => yRange(s.path));
    // 平移后（-crop.y）所有笔迹 y 落在 [0, 80] 页高内——不因包围盒漏线宽被裁
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(page.pixelHeight + 1);
  });
});

// ---------- 渲染：守卫（不吞错） ----------

describe("renderNotePage：错误路径不吞错且清理画布", () => {
  it("toBlob 返回 null → 拒绝并抛中文错误；离屏画布被清理", async () => {
    toBlobBehavior = () => null;
    const d = docOf([
      stroke([
        [10, 10],
        [200, 30],
      ]),
    ]);
    await expect(renderOne(d)).rejects.toThrow(/toBlob 返回空/);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("PNG 字节超单图限额 → 拒绝并指出限额", async () => {
    toBlobBehavior = () => new Uint8Array(NOTE_IMAGE_PNG_MAX_BYTES + 1);
    const d = docOf([
      stroke([
        [10, 10],
        [200, 30],
      ]),
    ]);
    await expect(renderOne(d)).rejects.toThrow(/超过.*限额/);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("像素维超防御上限 → 创建画布前即拒绝", async () => {
    const d = docOf([
      stroke([
        [10, 10],
        [200, 30],
      ]),
    ]);
    await expect(
      renderNotePage(d, {
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: NOTE_IMAGE_MAX_PIXEL_DIM + 1,
        pixelHeight: 100,
      }),
    ).rejects.toThrow(/像素维超出防御上限/);
  });

  it("无法取得 2d 上下文 → 明确报错", async () => {
    getContextSpy.mockImplementation(() => null);
    const d = docOf([
      stroke([
        [10, 10],
        [200, 30],
      ]),
    ]);
    await expect(renderOne(d)).rejects.toThrow(/canvas 2d/);
  });
});

// ---------- 渲染：隔离（A 导图期间 B 不污染） ----------

describe("renderNoteImages：实例隔离", () => {
  it("A 渲染编码挂起期间渲染 B：A 的画布命令不含 B 的颜色", async () => {
    const docA = docOf([
      stroke(
        [
          [10, 10],
          [900, 30],
        ],
        { color: INK_PEN_COLORS.red },
      ),
    ]);
    const docB = docOf([
      stroke(
        [
          [10, 10],
          [900, 30],
        ],
        { color: INK_PEN_COLORS.blue },
      ),
    ]);
    // 首个 toBlob 挂起（A 的编码），其余正常（B）
    let deferredFirst = true;
    toBlobBehavior = () => {
      if (deferredFirst) {
        deferredFirst = false;
        return "defer";
      }
      return new Uint8Array([2]);
    };
    const a = renderNoteImages(docA, "thumbnail");
    await vi.waitFor(() => expect(deferredToBlob.length).toBe(1));
    const bPages = await renderNoteImages(docB, "thumbnail");
    expect(bPages).toHaveLength(1);
    // 释放 A 的编码并等待完成
    for (const cb of deferredToBlob.splice(0)) {
      cb(new Blob([new Uint8Array([1])]));
    }
    await a;
    // 每个文档一个独立画布：红蓝不共现于任何画布
    expect(createdCanvases).toHaveLength(2);
    const ctxs = createdCanvases.map((c) => ctxOf(c));
    const redCtxs = ctxs.filter((ctx) =>
      ctx.strokeCalls.some((s) => s.style === INK_PEN_COLORS.red),
    );
    const blueCtxs = ctxs.filter((ctx) =>
      ctx.strokeCalls.some((s) => s.style === INK_PEN_COLORS.blue),
    );
    expect(redCtxs).toHaveLength(1);
    expect(blueCtxs).toHaveLength(1);
    for (const ctx of ctxs) {
      const hasRed = ctx.strokeCalls.some(
        (s) => s.style === INK_PEN_COLORS.red,
      );
      const hasBlue = ctx.strokeCalls.some(
        (s) => s.style === INK_PEN_COLORS.blue,
      );
      expect(hasRed && hasBlue).toBe(false);
    }
  });
});

// ---------- 渲染：产物元信息 ----------

describe("renderNoteImages：产物与上传元信息对齐", () => {
  it("长稿分析图逐页产出，尺寸/crop 可直接组装上传 meta；renderVersion 随产物声明", async () => {
    const tall = docOf(
      [
        stroke([
          [100, 60],
          [900, 2950],
        ]),
      ],
      {
        paperHeightLogical: 3000,
      },
    );
    const pages = await renderNoteImages(tall, "analysis");
    expect(pages.length).toBe(3);
    expect(pages[0]?.pageIndex).toBe(0);
    expect(pages[2]?.pageIndex).toBe(2);
    for (const p of pages) {
      expect(p.blob).toBeInstanceOf(Blob);
      expect(p.pixelWidth).toBe(ANALYSIS_PIXEL_WIDTH);
      // 上传 meta 硬上限链：像素维 ≤ 防御上限
      expect(p.pixelWidth).toBeLessThanOrEqual(NOTE_IMAGE_MAX_PIXEL_DIM);
      expect(p.pixelHeight).toBeLessThanOrEqual(NOTE_IMAGE_MAX_PIXEL_DIM);
    }
    expect(NOTE_RENDER_VERSION).toBe(1);
  });
});

// ---------- 测试辅助 ----------

/** renderNotePage 单页便捷封装（缩略图规格） */
function renderOne(d: NoteDoc) {
  return renderNoteImages(d, "thumbnail");
}

/** 渲染一页并返回该次渲染创建的离屏 canvas（渲染结束即被移除出 DOM，
 * 但录制上下文经 WeakMap 仍可查） */
async function captureCanvas(
  d: NoteDoc,
  pixelWidth = THUMBNAIL_PIXEL_WIDTH,
  cropOverride?: { x: number; y: number; width: number; height: number },
): Promise<HTMLCanvasElement> {
  const before = createdCanvases.length;
  if (cropOverride) {
    const pixelHeight = Math.round(
      (cropOverride.height * pixelWidth) / cropOverride.width,
    );
    await renderNotePage(d, {
      pageIndex: 0,
      crop: cropOverride,
      pixelWidth,
      pixelHeight,
    });
  } else {
    await renderNoteImages(d, "thumbnail");
  }
  const canvas = createdCanvases[createdCanvases.length - 1];
  if (!canvas || createdCanvases.length !== before + 1) {
    throw new Error("测试辅助：未捕获到本次渲染的 canvas");
  }
  return canvas;
}

/** 取 canvas 的录制上下文 */
function ctxOf(canvas: HTMLCanvasElement): RecordingContext {
  const ctx = ctxByCanvas.get(canvas);
  if (!ctx) throw new Error("测试辅助：未捕获到录制上下文");
  return ctx;
}

/** 路径是否轴向对齐线段：横线 = y 恒定（x 变化），竖线 = x 恒定 */
/** 展开路径全部坐标（x0,y0,x1,y1,…） */
function pathCoords(path: PathOp[]): number[] {
  const out: number[] = [];
  for (const op of path) {
    for (const v of op.pts) out.push(v);
  }
  return out;
}

function isAxisAligned(s: StrokeCall, axis: "h" | "v"): boolean {
  const pts = pathCoords(s.path);
  if (pts.length < 2) return false;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i];
    if (v === undefined) continue;
    if (i % 2 === 0) xs.push(v);
    else ys.push(v);
  }
  const firstX = xs[0];
  const firstY = ys[0];
  if (firstX === undefined || firstY === undefined) return false;
  return axis === "h"
    ? ys.every((v) => Math.abs(v - firstY) < 0.01)
    : xs.every((v) => Math.abs(v - firstX) < 0.01);
}

/** 取线段的 y 坐标（首点） */
function yOf(path: PathOp[]): number {
  return path[0]?.pts[1] ?? Number.NaN;
}

/** 取一条笔迹路径的所有 y 坐标 */
function yRange(path: PathOp[]): number[] {
  const out: number[] = [];
  for (const op of path) {
    const y0 = op.pts[1];
    if (y0 !== undefined) out.push(y0);
    if (op.pts.length >= 4) {
      const y1 = op.pts[3];
      if (y1 !== undefined) out.push(y1);
    }
  }
  return out;
}
