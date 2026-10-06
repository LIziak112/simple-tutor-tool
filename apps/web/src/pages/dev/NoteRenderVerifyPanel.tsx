import { type NoteDocInput, noteDocSchema } from "@tutor/contract";
import { Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  INK_HIGHLIGHTER,
  INK_PEN_COLORS,
} from "@/features/ink/engine/types.ts";
import {
  ANALYSIS_SLICE_OVERLAP_LOGICAL,
  renderNoteImages,
} from "@/features/notes/render-note.ts";

/**
 * T6R.6 渲染验证面板（/dev/ink 第 ④ 区块）：在**真实浏览器 canvas** 里跑
 * 独立渲染器并解码自己的 PNG 做内容级检查——这是任务验收「真实解码 PNG
 * 并做内容检查/基准图对照，不能只验魔数」的浏览器侧闸门（jsdom 无 2d
 * canvas，命令流级断言在 render-note.test.ts，两层互补）。
 *
 * 检查项与容差（改动须同步 e2e/note-render.spec.ts 的行数断言）：
 * - 像素分类容差：线色（#cbd5e1）判据 = 与线色欧氏距离 ≤60 且非纯白；
 *   墨迹 = 与纯白距离 >60；纯白 = 与纯白距离 ≤10。坐标断言 ±2px（AA 与
 *   取整）——不用大幅容差放过缺笔。
 * - 确定性：同文档同规格双渲染，PNG 字节逐位相等（容差 0；字节一致
 *   蕴含像素一致，不重复解码比对）。
 * - 🧑 待真机确认：长稿小字可读性、片高 1400/重叠 40 的翻页观感——本面板
 *   只能验证像素正确，不能替代 iPad 真机阅读体验。
 */

/** 长稿夹具的纸高（切片/确定性检查共用；与 render-note.test 同值） */
const TALL_PAPER_HEIGHT = 3000;

/** 单条检查结论 */
interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}

// ---------- 文档工厂（页面内确定性夹具） ----------

function pageStroke(
  points: Array<[number, number]>,
  o: { color?: string; weight?: number; tool?: "pen" | "highlighter" } = {},
): NoteDocInput["ink"]["strokes"][number] {
  return {
    tool: o.tool ?? "pen",
    color: o.color ?? INK_PEN_COLORS.black,
    weight: o.weight ?? 4,
    points: points.map(([x, y]) => ({ x, y, p: 0.5, t: 0 })),
  };
}

/**
 * 密集折线笔画：沿顶点每 ~5 逻辑单位插一个点。真实书写/回放的点距也是
 * 这个量级——atrament 平滑对每点只前进 ~17% 距离，2-3 点的稀疏笔画绘制
 * 终点会大幅滞后（这是引擎原语的既有语义，渲染器如实复现），检查夹具
 * 必须用密集点才能断言完整笔迹。
 */
function denseStroke(
  vertices: Array<[number, number]>,
  o: { color?: string; weight?: number; tool?: "pen" | "highlighter" } = {},
): NoteDocInput["ink"]["strokes"][number] {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < vertices.length; i++) {
    const [x1, y1] = vertices[i] as [number, number];
    const [x2, y2] = vertices[i + 1] as [number, number];
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 5));
    for (let k = 0; k < steps; k++) {
      pts.push([x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps]);
    }
  }
  const last = vertices[vertices.length - 1] as [number, number];
  pts.push(last);
  return pageStroke(pts, o);
}

function docOf(
  strokes: NoteDocInput["ink"]["strokes"],
  o: {
    background?: NoteDocInput["background"];
    paperHeightLogical?: number;
  } = {},
) {
  return noteDocSchema.parse({
    version: 1,
    ink: { width: 1000, strokes },
    ...(o.background !== undefined ? { background: o.background } : {}),
    ...(o.paperHeightLogical !== undefined
      ? { paperHeightLogical: o.paperHeightLogical }
      : {}),
  });
}

// ---------- 像素工具（真实解码） ----------

async function decodeToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建解码画布上下文");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

const LINE_RGB: readonly [number, number, number] = [203, 213, 225]; // #cbd5e1
const WHITE_RGB: readonly [number, number, number] = [255, 255, 255];

function dist(
  r: number,
  g: number,
  b: number,
  t: readonly [number, number, number],
): number {
  const dr = r - t[0];
  const dg = g - t[1];
  const db = b - t[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function px(img: ImageData, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

/** 采样容差 ±2px 的区域是否存在满足谓词的像素（坐标断言口径） */
function anyPixelIn(
  img: ImageData,
  cx: number,
  cy: number,
  pred: (rgb: [number, number, number]) => boolean,
  radius = 2,
): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(cx) + dx;
      const y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (pred(px(img, x, y))) return true;
    }
  }
  return false;
}

const isLine = (rgb: [number, number, number]) =>
  dist(...rgb, LINE_RGB) <= 60 && dist(...rgb, WHITE_RGB) > 30;
const isInk = (rgb: [number, number, number]) => dist(...rgb, WHITE_RGB) > 60;
const isPureWhite = (rgb: [number, number, number]) =>
  dist(...rgb, WHITE_RGB) <= 10;
const isRedInk = (rgb: [number, number, number]) =>
  rgb[0] > 150 && rgb[1] < 120 && rgb[2] < 120;
const isYellowHighlight = (rgb: [number, number, number]) =>
  rgb[0] > 200 && rgb[1] > 180 && rgb[2] < 210 && dist(...rgb, WHITE_RGB) > 60;

/** 逐字节比较两个 blob（确定性检查，容差 0） */
async function bytesEqual(a: Blob, b: Blob): Promise<boolean> {
  const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (ba.byteLength !== bb.byteLength) return false;
  const ua = new Uint8Array(ba);
  const ub = new Uint8Array(bb);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

// ---------- 检查链 ----------

/** 渲染单页规格并解码为像素数据（单页检查的共用样板） */
async function renderPng(
  doc: ReturnType<typeof docOf>,
  spec: "thumbnail" | "analysis",
): Promise<ImageData> {
  return decodeToImageData(firstPage(await renderNoteImages(doc, spec)).blob);
}

/** 取单页渲染产物（这些检查的分析图都恰为单页；否则视为检查失败） */
function firstPage(
  pages: Awaited<ReturnType<typeof renderNoteImages>>,
): Awaited<ReturnType<typeof renderNoteImages>>[number] {
  if (pages.length !== 1) {
    throw new Error(`期望单页，得到 ${pages.length}`);
  }
  const page = pages[0];
  if (!page) throw new Error("第 0 页缺失");
  return page;
}

async function runChecks(): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  const check = async (
    name: string,
    fn: () => Promise<string>,
  ): Promise<void> => {
    try {
      const detail = await fn();
      verdicts.push({ name, pass: true, detail });
    } catch (err) {
      verdicts.push({
        name,
        pass: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  // 分析图：背景 + 笔迹文档。笔迹 y∈[380,420] → 裁剪区 [320,480]（160 高）
  const bgStroke = [
    denseStroke([
      [100, 380],
      [900, 420],
    ]),
  ];
  const inkY = (logical: number) => logical - 320; // 逻辑 → 页内像素（s=1）

  await check("背景 white：整页白底 + 墨迹，无格线色像素", async () => {
    const img = await renderPng(
      docOf(bgStroke, { background: "white" }),
      "analysis",
    );
    // 四角纯白（留 8px 边距避开裁剪边缘 AA）
    const corners: Array<[number, number]> = [
      [8, 8],
      [img.width - 8, 8],
      [8, img.height - 8],
      [img.width - 8, img.height - 8],
    ];
    for (const [x, y] of corners) {
      if (!isPureWhite(px(img, x, y)))
        fail(`角点 (${x},${y}) 非纯白：${px(img, x, y)}`);
    }
    // 笔迹中点有墨（y=400 → 页内 80）
    if (!anyPixelIn(img, 500, inkY(400), isInk)) fail("笔迹中点无墨迹像素");
    // 墨带外区域不得出现格线色（密集墨迹的 AA 边缘浅灰与线色同量级，
    // 属于墨不属于背景——只扫墨带外：bgStroke y∈[378,422] ± 余量 → 页内
    // 墨带约 [52,112]，扫 [0,48] 与 [116,160)）
    let linePixels = 0;
    for (let y = 0; y < 48; y += 2) {
      for (let x = 0; x < img.width; x += 2) {
        if (isLine(px(img, x, y))) linePixels++;
      }
    }
    for (let y = 116; y < img.height; y += 2) {
      for (let x = 0; x < img.width; x += 2) {
        if (isLine(px(img, x, y))) linePixels++;
      }
    }
    if (linePixels > 0) fail(`white 背景墨带外出现 ${linePixels} 个格线色像素`);
    return `1000×${img.height}，白底含墨无格线`;
  });

  await check(
    "背景 grid：格线实际入图（竖线 x=360、横线 y=360 可采样）",
    async () => {
      const img = await renderPng(
        docOf(bgStroke, { background: "grid" }),
        "analysis",
      );
      // 竖线：逻辑 x=360 → 页内 x=360；横线：逻辑 y=360 → 页内 y=40
      if (!anyPixelIn(img, 360, 100, isLine, 1))
        fail("竖线位置 (360,100) 未见格线色");
      if (!anyPixelIn(img, 500, inkY(360), isLine, 1))
        fail("横线位置未见格线色");
      // 无格线的位置不该有格线色（x=350 与 x=360 相差 10，中间应为白/墨）
      if (anyPixelIn(img, 350, 100, isLine, 1))
        fail("非格线位置 (350,100) 出现格线色");
      return "竖横格线均在位且间距正确";
    },
  );

  await check("背景 line：只有横线（竖线位置无格线色）", async () => {
    const img = await renderPng(
      docOf(bgStroke, { background: "line" }),
      "analysis",
    );
    if (!anyPixelIn(img, 500, inkY(360), isLine, 1)) fail("横线缺失");
    if (anyPixelIn(img, 360, 100, isLine, 1)) fail("line 背景出现竖线");
    return "仅横线";
  });

  await check("轻划（密集微笔）落墨：点位有墨迹", async () => {
    // 两点相距 6 逻辑单位的微笔（真实轻点的形态）：crop y=[320,480]
    const img = await renderPng(
      docOf([
        denseStroke([
          [497, 399],
          [503, 401],
        ]),
      ]),
      "analysis",
    );
    if (!anyPixelIn(img, 500, inkY(400), isInk, 3))
      fail("微笔未见墨迹（轻点丢失）");
    return "微笔墨迹在位";
  });

  await check(
    "零长笔画（孤立单点）按引擎现状不渲染（变更须递增 renderVersion）",
    async () => {
      // 引擎原语现状：单点 = 零长二次曲线，Chromium/WebKit 均不落墨；实时
      // 书写画布同样不显示（图文一致）。若未来引擎改为画圆点，此处会失败
      // ——按契约口径递增 NOTE_RENDER_VERSION 后同步本检查。
      const img = await renderPng(
        docOf([pageStroke([[500, 400]])]),
        "analysis",
      );
      let inkPixels = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const rgb: [number, number, number] = [
          img.data[i] ?? 0,
          img.data[i + 1] ?? 0,
          img.data[i + 2] ?? 0,
        ];
        if (isInk(rgb)) inkPixels++;
      }
      if (inkPixels > 0)
        fail(`单点笔画渲染出 ${inkPixels} 个墨迹像素（与引擎现状不符）`);
      return "单点零墨，与实时画布一致";
    },
  );

  await check("荧光笔：黄色半透明笔迹可检出", async () => {
    const pages = await renderNoteImages(
      docOf([
        denseStroke(
          [
            [150, 390],
            [850, 410],
          ],
          {
            tool: "highlighter",
            color: INK_HIGHLIGHTER.color,
            weight: INK_HIGHLIGHTER.weight,
          },
        ),
      ]),
      "analysis",
    );
    const img = await decodeToImageData(firstPage(pages).blob);
    if (!anyPixelIn(img, 500, inkY(400), isYellowHighlight, 3))
      fail("荧光笔笔迹未检出（黄色混合色缺失）");
    return "荧光笔颜色在位";
  });

  await check("擦除后图文一致：被擦笔画不再出现", async () => {
    const black = denseStroke([
      [100, 380],
      [450, 420],
    ]);
    const red = denseStroke(
      [
        [550, 380],
        [900, 420],
      ],
      {
        color: INK_PEN_COLORS.red,
      },
    );
    const imgA = await renderPng(docOf([black, red]), "analysis");
    const imgB = await renderPng(docOf([black]), "analysis");
    if (!anyPixelIn(imgA, 720, inkY(400), isRedInk, 3))
      fail("红笔笔画在原文档中缺失（夹具异常）");
    if (anyPixelIn(imgB, 720, inkY(400), isRedInk, 3))
      fail("擦除后的文档仍渲染出红笔（图文不一致）");
    return "擦除区域无红墨";
  });

  await check("长稿切片：3 页、顺序/尺寸/重叠正确", async () => {
    const tall = docOf(
      [
        denseStroke([
          [100, 60],
          [500, 1450],
          [900, 2950],
        ]),
      ],
      { paperHeightLogical: TALL_PAPER_HEIGHT },
    );
    const pages = await renderNoteImages(tall, "analysis");
    if (pages.length !== 3) fail(`期望 3 页，得到 ${pages.length}`);
    const p0 = pages[0];
    if (!p0) throw new Error("第 0 页缺失");
    const p1 = pages[1];
    if (!p1) throw new Error("第 1 页缺失");
    const p2 = pages[2];
    if (!p2) throw new Error("第 2 页缺失");
    if (p0.crop.y !== 0 || p0.crop.height !== 1400)
      fail(`第 0 页区域异常：y=${p0.crop.y} h=${p0.crop.height}`);
    if (p1.crop.y !== 1400 - ANALYSIS_SLICE_OVERLAP_LOGICAL)
      fail(`第 1 页起点非重叠推进：y=${p1.crop.y}`);
    if (p2.crop.y + p2.crop.height !== 3000) fail("末页未覆盖到记录范围底部");
    if (p0.pixelWidth !== 1000 || p0.pixelHeight !== 1400)
      fail(`像素尺寸异常：${p0.pixelWidth}×${p0.pixelHeight}`);
    // 跨页笔迹可读：第 1 页内取第二段笔画中点（逻辑 (700,2200)，远离
    // 顶点平滑圆角与页缘）应有墨迹——重叠区承接跨页笔迹的几何由 crop
    // 断言保证（上两条），像素断言只证该页确有笔迹
    const img1 = await decodeToImageData(p1.blob);
    if (!anyPixelIn(img1, 700, 2200 - p1.crop.y, isInk, 8))
      fail("第 1 页中段未见笔迹（跨页笔迹缺失）");
    return `3 页 [0,1400]/[1360,2760]/[2720,3000]，重叠 ${ANALYSIS_SLICE_OVERLAP_LOGICAL}`;
  });

  await check("确定性：同文档同规格双渲染字节一致（容差 0）", async () => {
    const tall = docOf(
      [
        denseStroke([
          [100, 60],
          [500, 1450],
          [900, 2950],
        ]),
      ],
      { paperHeightLogical: TALL_PAPER_HEIGHT },
    );
    const [a, b] = await Promise.all([
      renderNoteImages(tall, "analysis"),
      renderNoteImages(tall, "analysis"),
    ]);
    if (a.length !== b.length) fail("两次渲染页数不同");
    for (let i = 0; i < a.length; i++) {
      const pa = a[i];
      const pb = b[i];
      if (!pa || !pb) throw new Error(`第 ${i} 页缺失`);
      if (!(await bytesEqual(pa.blob, pb.blob)))
        fail(`第 ${i} 页两次渲染字节不一致`);
    }
    // 字节逐位一致是比像素一致更强的断言（蕴含像素/尺寸一致），不再重复
    // 双解码像素循环（复审⑤：死代码删除，保留更强的一侧）
    return "全页字节逐位一致（蕴含像素一致）";
  });

  await check("缩略图：整纸低分辨率单页", async () => {
    const img = await renderPng(docOf(bgStroke), "thumbnail");
    if (img.width !== 480 || img.height !== 384)
      fail(`缩略图尺寸异常：${img.width}×${img.height}`);
    if (!anyPixelIn(img, 240, 192, isInk, 4)) fail("缩略图未见墨迹");
    return "480×384 含墨";
  });

  return verdicts;
}

/** T6R.6 渲染验证面板（真实 canvas；只在浏览器/E2E 中运行有意义） */
export function NoteRenderVerifyPanel() {
  const [rows, setRows] = useState<Verdict[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    setRows(null);
    try {
      setRows(await runChecks());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const passCount = rows?.filter((r) => r.pass).length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          className="h-11"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? (
            "验证中…"
          ) : (
            <>
              <Play aria-hidden /> 运行渲染验证
            </>
          )}
        </Button>
        {rows && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {passCount}/{rows.length} 通过
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          验证链异常：{error}
        </p>
      )}
      {rows && (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.name}
              data-verdict={r.pass ? "pass" : "fail"}
              className="text-xs leading-5"
            >
              <span className={r.pass ? "text-foreground" : "text-destructive"}>
                {r.pass ? "[通过]" : "[失败]"}
              </span>{" "}
              {r.name}
              {!r.pass && (
                <span className="text-destructive"> —— {r.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
