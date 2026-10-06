/**
 * 题目草稿独立渲染器（T6R.6）：从固定 NoteDoc + 渲染规格确定性产出 PNG 页。
 * 依据：docs/题目草稿功能方案.md §7（PNG、预算与恢复）、§4.3（背景进入实际
 * 图像）、docs/Phase6任务清单.md T6R.6。
 *
 * 与活编辑器的关系（方案 §7 硬约束）：
 * - **不截图活 canvas、不混入未结束笔画**——只消费已提交的 NoteDoc.strokes；
 * - 复用引擎重绘原语 replayAtramentStroke（atrament 官方程序化绘制，与实时
 *   书写/全量重绘/回放同一绘制路径），不另写笔迹绘制；
 * - 每页一个**独立离屏 canvas**（挂在 body 下、absolute 移出视口但参与布局：
 *   atrament 5.x 内部用 canvas.offsetWidth/offsetHeight 做坐标换算，脱离布局
 *   的 canvas 两值为 0，除零得 NaN——与 T6R.1 实验室离屏宿主同一坑位），
 *   渲染完立即移除，天然与编辑器/A 文档互不污染；
 * - 确定性 = 同一文档 + 规格 + NOTE_RENDER_VERSION 下内容与坐标一致；不承诺
 *   跨浏览器 PNG 字节一致（抗锯齿实现差异，方案 §7 原文口径）。每页新建
 *   Atrament 实例（atrament 的压力平滑状态跨笔画残留，实例级隔离保证逐页
 *   确定性）。
 *
 * ⚠️ 本文件所有数值常量均为**暂定值**（方案 §7 建议起点 / T6R.1 桌面观测），
 * 真机定标（长稿小字可读性）后修订；**改任何影响像素输出的值必须递增契约
 * NOTE_RENDER_VERSION**（见 packages/contract/src/note.ts 注释）。
 * 🧑 待真机确认点：分析图 1000 宽的小字可读性、片高 1400 与重叠 40 的翻页
 * 阅读效果、缩略图 480 宽在折叠题卡上的辨识度。
 */

import {
  NOTE_IMAGE_MAX_PIXEL_DIM,
  NOTE_IMAGE_PNG_MAX_BYTES,
  type NoteCropRect,
  type NoteDoc,
  type NoteImageSpec,
  type NoteImageUploadMeta,
} from "@tutor/contract";
import Atrament from "atrament";
import { replayAtramentStroke } from "@/features/ink/engine/atrament-adapter.ts";
import { INK_LOGICAL_WIDTH } from "@/features/ink/engine/types.ts";

// ---------- 渲染规格常量（全部暂定，真机定标后修订） ----------

/**
 * 纸张格线/横线间距（逻辑单位）。屏幕（T6R.7）、PNG、历史回看共用同一间距
 * （方案 §4.3）；导出供屏幕端画法复用，不得在别处另写数值。
 */
export const NOTE_PAPER_GRID_SPACING_LOGICAL = 40;

/** 格线/横线颜色（画进 PNG 的实际描边色，非 CSS） */
export const NOTE_PAPER_LINE_COLOR = "#cbd5e1";

/** PNG 底色：渲染统一白底（教师/AI 查看口径，同旧 exportPng） */
export const NOTE_PAPER_BG_COLOR = "#ffffff";

/**
 * 分析图像素宽（= 逻辑宽 1000 的 1:1 像素）。方案 §7：先以约 1000 试验，
 * 需要更清楚时提高至约 1500——**提清 = 影响像素输出 = 递增 renderVersion**，
 * 不做运行时可调（确定性要求同文档同规格唯一输出）。
 */
export const ANALYSIS_PIXEL_WIDTH = 1000;

/**
 * 缩略图像素宽（低分辨率整纸总览，方案 §7「缩略图单独低分辨率」）。
 * 用于折叠题卡的缩略显示；比例 480/1000。
 */
export const THUMBNAIL_PIXEL_WIDTH = 480;

/**
 * 分析图单页最大逻辑高（切片片高上限＝长边限制之一）。
 * 1400 与 1000 宽的比例约 1:1.4（A4 纵向阅读比），T6R.1 桌面观测：整幅
 * 1000×3000 在 800→1600 笔触线触 2MiB，按 1400 切片后单片预算余量充足。
 */
export const ANALYSIS_SLICE_HEIGHT_LOGICAL = 1400;

/**
 * 分析图切片重叠区（逻辑单位）。方案 §7 建议初值 40（恰一格线间距）。
 * **模型提示词侧不得把重叠区当重复演算内容**（T6R.17 提示词任务引用本常量
 * 生成页间说明）；重叠只保证跨页笔迹完整可读。
 */
export const ANALYSIS_SLICE_OVERLAP_LOGICAL = 40;

/**
 * 分析图单页总像素上限（长边限制之外的独立约束，方案 §7「每片长边与总像素
 * 同时限制」）。与 ANALYSIS_SLICE_HEIGHT_LOGICAL 同时生效：片高 =
 * min(长边上限, floor(总像素 / 像素宽))。当前 1000 宽下两者同为 1400；
 * 将来提清到 1500 宽时本约束把片高压到 933。
 */
export const ANALYSIS_SLICE_MAX_PIXELS = 1_400_000;

/**
 * 分析图裁剪留白（逻辑单位）：记录范围包围盒（已含线宽）外再留的边距，
 * 随后向网格间距对齐。48 > 荧光笔最大半线宽 8 + 一格余量。
 */
export const ANALYSIS_CROP_PADDING_LOGICAL = 48;

// ---------- 页面计划（纯几何，与 canvas 无关） ----------

/** 一页派生图的渲染计划：crop 逻辑裁剪区 + 目标像素尺寸 + 页号 */
export interface NotePagePlan {
  /** 同版本同规格内从 0 递增（与上传槽位 noteImageUploadMeta.pageIndex 对齐） */
  pageIndex: number;
  /** 逻辑裁剪区（含坐标原点，重放时平移到页原点） */
  crop: NoteCropRect;
  pixelWidth: number;
  pixelHeight: number;
}

/** 渲染产物：计划 + PNG 字节 */
export interface RenderedNotePage extends NotePagePlan {
  blob: Blob;
}

/** 单笔包围盒接口（含线宽后的取值范围） */
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 全稿笔迹包围盒（**含每笔半线宽**：粗笔/荧光笔边缘不被裁切，任务验收项
 * 「最高笔迹包围盒含线宽不裁切」）。空稿返回 null。
 */
export function inkBBoxLogical(ink: NoteDoc["ink"]): BBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of ink.strokes) {
    const half = s.weight / 2;
    for (const pt of s.points) {
      if (pt.x - half < minX) minX = pt.x - half;
      if (pt.y - half < minY) minY = pt.y - half;
      if (pt.x + half > maxX) maxX = pt.x + half;
      if (pt.y + half > maxY) maxY = pt.y + half;
    }
  }
  if (minX === Number.POSITIVE_INFINITY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 分析图裁剪区：横向恒整宽 0..1000（保留版面结构，两栏书写比例不失真），
 * 纵向取记录范围（包围盒含线宽）± 留白，再向网格间距对齐（切片顶恰在格线
 * 上，翻页视觉稳定），并钳制在纸内。空稿返回整纸（诚实呈现空纸，是否出图
 * 由调用方决定——确认空稿的交卷证据不产图）。
 */
export function planAnalysisCrop(doc: NoteDoc): NoteCropRect {
  const spacing = NOTE_PAPER_GRID_SPACING_LOGICAL;
  const bbox = inkBBoxLogical(doc.ink);
  if (bbox === null) {
    return {
      x: 0,
      y: 0,
      width: INK_LOGICAL_WIDTH,
      height: doc.paperHeightLogical,
    };
  }
  const pad = ANALYSIS_CROP_PADDING_LOGICAL;
  // 向网格对齐：floor/ceil 到 spacing 的整数倍，再钳制 [0, paperHeight]
  let y0 = Math.floor((bbox.minY - pad) / spacing) * spacing;
  let y1 = Math.ceil((bbox.maxY + pad) / spacing) * spacing;
  if (y0 < 0) y0 = 0;
  if (y1 > doc.paperHeightLogical) y1 = doc.paperHeightLogical;
  // 防御闭合：bbox 非空且 pad>0 时 y1>y0 恒成立，此处兜底极端舍入
  if (y1 <= y0) y1 = Math.min(doc.paperHeightLogical, y0 + spacing);
  return {
    x: 0,
    y: y0,
    width: INK_LOGICAL_WIDTH,
    height: y1 - y0,
  };
}

/** 给定像素宽下允许的切片逻辑高上限（长边与总像素两约束取小） */
export function analysisSliceHeightMax(pixelWidth: number): number {
  return Math.min(
    ANALYSIS_SLICE_HEIGHT_LOGICAL,
    Math.floor(ANALYSIS_SLICE_MAX_PIXELS / pixelWidth),
  );
}

/**
 * 把裁剪区按片高与重叠切成有序页区（纯函数，方案 §7 切片记录顺序/重叠）：
 * - 顺序即阅读顺序（pageIndex 由调用方按序赋 0 起）；
 * - 相邻页重叠恰 ANALYSIS_SLICE_OVERLAP_LOGICAL（笔迹跨页完整可读）；
 * - 末页覆盖到裁剪区底部，且除首末页外每页高度恒为片高上限。
 */
export function sliceCropRects(crop: NoteCropRect): NoteCropRect[] {
  const maxH = analysisSliceHeightMax(ANALYSIS_PIXEL_WIDTH);
  const overlap = ANALYSIS_SLICE_OVERLAP_LOGICAL;
  if (overlap >= maxH) {
    throw new Error(
      `切片参数非法：重叠（${overlap}）必须小于片高（${maxH}），否则切片不推进`,
    );
  }
  if (crop.height <= maxH) return [crop];
  const bottom = crop.y + crop.height;
  const pages: NoteCropRect[] = [];
  let y = crop.y;
  // 循环不变量：y < bottom；每轮推进 maxH-overlap > 0，必然终止
  for (;;) {
    const end = Math.min(y + maxH, bottom);
    pages.push({ x: crop.x, y, width: crop.width, height: end - y });
    if (end >= bottom) break;
    y = end - overlap;
  }
  return pages;
}

/** 逻辑高 → 像素高（等比缩放取整；与像素宽共同受防御上限约束） */
function pixelHeightOf(crop: NoteCropRect, pixelWidth: number): number {
  return Math.max(1, Math.round((crop.height * pixelWidth) / crop.width));
}

/** 缩略图计划：整纸、低分辨率（pageIndex 恒 0） */
export function planThumbnailPage(doc: NoteDoc): NotePagePlan {
  const crop: NoteCropRect = {
    x: 0,
    y: 0,
    width: INK_LOGICAL_WIDTH,
    height: doc.paperHeightLogical,
  };
  return {
    pageIndex: 0,
    crop,
    pixelWidth: THUMBNAIL_PIXEL_WIDTH,
    pixelHeight: pixelHeightOf(crop, THUMBNAIL_PIXEL_WIDTH),
  };
}

/** 分析图计划：记录范围裁剪 + 按需切片（pageIndex 从 0 递增） */
export function planAnalysisPages(doc: NoteDoc): NotePagePlan[] {
  return sliceCropRects(planAnalysisCrop(doc)).map((crop, i) => ({
    pageIndex: i,
    crop,
    pixelWidth: ANALYSIS_PIXEL_WIDTH,
    pixelHeight: pixelHeightOf(crop, ANALYSIS_PIXEL_WIDTH),
  }));
}

/** 一个版本的全套页面计划（缩略图 + 分析切片）；补图/重建按此对齐槽位 */
export function planNoteImagePages(doc: NoteDoc): {
  thumbnail: NotePagePlan;
  analysis: NotePagePlan[];
} {
  return {
    thumbnail: planThumbnailPage(doc),
    analysis: planAnalysisPages(doc),
  };
}

/** 渲染产物 → 上传元信息（字段集与 noteImageUploadMetaSchema 一一对应） */
export function noteImageUploadMetaOf(
  spec: NoteImageSpec,
  page: Pick<
    RenderedNotePage,
    "pageIndex" | "crop" | "pixelWidth" | "pixelHeight"
  >,
): NoteImageUploadMeta {
  return {
    spec,
    pageIndex: page.pageIndex,
    crop: page.crop,
    pixelWidth: page.pixelWidth,
    pixelHeight: page.pixelHeight,
  };
}

// ---------- 页面渲染（需要 DOM canvas） ----------

/** 单笔包围盒（含半线宽；空笔画返回 null） */
function strokeBBox(s: NoteDoc["ink"]["strokes"][number]): BBox | null {
  if (s.points.length === 0) return null;
  const half = s.weight / 2;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of s.points) {
    if (pt.x - half < minX) minX = pt.x - half;
    if (pt.y - half < minY) minY = pt.y - half;
    if (pt.x + half > maxX) maxX = pt.x + half;
    if (pt.y + half > maxY) maxY = pt.y + half;
  }
  return { minX, minY, maxX, maxY };
}

/** 笔迹包围盒与页裁剪区是否相交（页外笔画不重放，跨页笔画经重叠区覆盖） */
function strokeIntersectsCrop(
  s: NoteDoc["ink"]["strokes"][number],
  crop: NoteCropRect,
): boolean {
  const bb = strokeBBox(s);
  if (bb === null) return false;
  return (
    bb.minX <= crop.x + crop.width &&
    bb.maxX >= crop.x &&
    bb.minY <= crop.y + crop.height &&
    bb.maxY >= crop.y
  );
}

/**
 * 把纸张背景画进 PNG（方案 §4.3：屏幕/PNG/历史回看同一间距；背景不能只靠
 * CSS——任务失败测试「CSS 背景也出现在 PNG」的对应实现）。white = 纯白底；
 * grid = 格线（横+竖）；line = 横线。线条只画裁剪区**内部**的网格倍数线。
 */
function paintPaperBackground(
  ctx: CanvasRenderingContext2D,
  background: NoteDoc["background"],
  crop: NoteCropRect,
  pixelWidth: number,
  pixelHeight: number,
): void {
  ctx.fillStyle = NOTE_PAPER_BG_COLOR;
  ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  if (background === "white") return;
  const spacing = NOTE_PAPER_GRID_SPACING_LOGICAL;
  const scale = pixelWidth / crop.width;
  ctx.strokeStyle = NOTE_PAPER_LINE_COLOR;
  ctx.lineWidth = 1;
  const firstAfter = (edge: number): number =>
    Math.floor(edge / spacing) * spacing + spacing;
  // 横线（line/grid 共有）
  for (let gy = firstAfter(crop.y); gy < crop.y + crop.height; gy += spacing) {
    const y = (gy - crop.y) * scale;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(pixelWidth, y);
    ctx.stroke();
  }
  if (background === "grid") {
    for (let gx = firstAfter(crop.x); gx < crop.x + crop.width; gx += spacing) {
      const x = (gx - crop.x) * scale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, pixelHeight);
      ctx.stroke();
    }
  }
}

/** canvas.toBlob 包装：返回 null 时拒绝（不吞错），成功解析为 Blob */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else
        reject(
          new Error("PNG 编码失败：toBlob 返回空（画布不可用或内存不足）"),
        );
    }, "image/png");
  });
}

/**
 * 渲染一页：背景 + 笔迹 → PNG。独立于活编辑器与 React 生命周期（离屏画布
 * 自建自毁；「组件卸载不吞错」由本函数不依赖组件状态保证——错误原样抛出）。
 * @param doc 已物化默认值的 NoteDoc（调用方经 noteDocSchema.parse 收窄）
 * @param page 页面计划（planXxx 的产物；防御上限校验在此兜底）
 */
export async function renderNotePage(
  doc: NoteDoc,
  page: NotePagePlan,
): Promise<RenderedNotePage> {
  const { crop, pixelWidth, pixelHeight } = page;
  if (
    pixelWidth < 1 ||
    pixelHeight < 1 ||
    pixelWidth > NOTE_IMAGE_MAX_PIXEL_DIM ||
    pixelHeight > NOTE_IMAGE_MAX_PIXEL_DIM
  ) {
    throw new Error(
      `像素维超出防御上限（${pixelWidth}×${pixelHeight}，上限 ${NOTE_IMAGE_MAX_PIXEL_DIM}）：拒绝渲染`,
    );
  }
  if (typeof document === "undefined") {
    throw new Error("渲染草稿图片需要浏览器 DOM 环境");
  }
  // 离屏但参与布局（offsetWidth/offsetHeight 需为非 0：atrament 坐标换算
  // 依赖，见文件头注释）；CSS 尺寸 = 逻辑裁剪区（css 坐标系与逻辑坐标 1:1）
  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.style.position = "absolute";
  canvas.style.left = "-9999px";
  canvas.style.top = "0";
  canvas.style.width = `${crop.width}px`;
  canvas.style.height = `${crop.height}px`;
  document.body.appendChild(canvas);
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("渲染失败：无法创建 canvas 2d 上下文（当前环境不支持）");
    }
    // 构造 atrament（配置画笔状态）后立即解绑其内部指针监听：只做程序化
    // 重放，不接管输入（atrament-adapter / replay/draw 同款手法）
    const atrament = new Atrament(canvas);
    atrament.destroy();

    paintPaperBackground(ctx, doc.background, crop, pixelWidth, pixelHeight);

    // 重放笔迹：页内相交的笔画平移到页原点后按引擎原语绘制。注意引擎
    // 原语的既有语义：零长笔画（孤立单点 = 零长二次曲线）不落墨、稀疏
    // 点笔画的绘制终点按平滑追赶滞后——渲染器如实复现（图文一致以实时
    // 画布为准，E2E 面板有对应守卫检查）。cssWidth 传
    // INK_LOGICAL_WIDTH ⇒ css 坐标 == 逻辑坐标，atrament 再按
    // canvas.width/offsetWidth（= pixelWidth/crop.width）等比映射到设备像素
    for (const s of doc.ink.strokes) {
      if (!strokeIntersectsCrop(s, crop)) continue;
      replayAtramentStroke(atrament, INK_LOGICAL_WIDTH, {
        tool: s.tool,
        color: s.color,
        weight: s.weight,
        points: s.points.map((pt) => ({
          x: pt.x - crop.x,
          y: pt.y - crop.y,
          p: pt.p,
          t: pt.t,
        })),
      });
    }

    const blob = await canvasToPngBlob(canvas);
    if (blob.size > NOTE_IMAGE_PNG_MAX_BYTES) {
      throw new Error(
        `单张派生图 PNG 超过 ${NOTE_IMAGE_PNG_MAX_BYTES / (1024 * 1024)}MiB 限额（暂定值）：` +
          `第 ${page.pageIndex} 页 ${blob.size} 字节；请等待切片参数定标修订或减少内容密度`,
      );
    }
    return { ...page, blob };
  } finally {
    canvas.remove();
  }
}

/**
 * 按规格渲染全套页面（缩略图一页 / 分析图按需多页）。逐页渲染并在页间让出
 * 事件循环（长稿多页不阻塞交互）；错误原样上抛（不吞错），已渲染页随异常
 * 丢弃——重试整链重入（上传槽位幂等 upsert，安全）。
 */
export async function renderNoteImages(
  doc: NoteDoc,
  spec: NoteImageSpec,
): Promise<RenderedNotePage[]> {
  const pages =
    spec === "thumbnail" ? [planThumbnailPage(doc)] : planAnalysisPages(doc);
  const out: RenderedNotePage[] = [];
  for (const page of pages) {
    if (out.length > 0) {
      // 页间让出：编码与重放都在主线程，多页长稿别一口气占满
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    out.push(await renderNotePage(doc, page));
  }
  return out;
}
