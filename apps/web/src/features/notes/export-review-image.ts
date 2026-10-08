import type { ReviewPackPreviewData, ReviewPackRole } from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";

/**
 * 静态合成图导出（T6R.19，方案 §10「合成图与题干圈画」）：把单题授权材料
 * （T6R.12/13 的 review-pack 预览载荷——服务端已按角色投影）合成为固定宽度
 * 静态版式图片（题干＋学生答案＋原稿/草稿图，白底、去控件、长内容分页）。
 *
 * 分层（本文件）：
 * - 纯函数层：版式区块模型（buildReviewImageSections）、分页计划
 *   （planReviewImagePages）、画布像素预算（reviewImageCanvasPixelSize）、
 *   文件名（reviewImageFilename）——无 DOM 依赖，jsdom 直测；
 * - 栅格化适配器层（exportReviewImages + ReviewImageExportDeps）：离屏构建
 *   DOM → 测量 → 分页 → html-to-image 栅格化 → PNG 校验 → 下载，失败显式
 *   分类（ReviewImageExportError），绝不「下载空白图后显示成功」。
 *
 * 材料口径（沿用 T6R.12/13，不重新实现投影）：
 * - 题面 = preview.questionMd（服务端 buildStaticQuestionMaterial 产物——
 *   ::graph 已参数化为文字说明、fold/steps 已加静态标记；::image 指令行由
 *   渲染层降级为「配图见下方附件区」，图片本体走 attachments 附件区块）；
 * - 学生红线：学生载荷不含参考答案/判定/评语/解析是服务端结构性不变量；
 *   本模块的 buildReviewImageSections 是纵深防御第二道（哨兵命中即拒绝
 *   生成——答案内容完全不进入版式模型，更不进入离屏渲染 DOM）；
 * - html-to-image 依赖 SVG foreignObject（方案 §10：不能当像素保真承诺），
 *   任何失败回落面板既有出口（完整包 zip / 复制文字 / 逐张图片下载）。
 *
 * ⚠️ 所有尺寸常量为暂定值（方案 §7 纪律：真机定标前以建议起点为准），
 * 🧑 待真机确认点见 docs/审查报告/T6R.19-实施报告.md。
 */

// ---------- 版式常量（暂定值） ----------

/** 合成图固定逻辑宽（CSS px；方案 §10「固定宽度」） */
export const REVIEW_IMAGE_WIDTH_CSS = 720;

/** 像素比（2x 导出：小字与公式笔画在 AI 侧可读） */
export const REVIEW_IMAGE_PIXEL_RATIO = 2;

/** 页面上下留白（CSS px；左右留白同值，见 PAGE_PADDING 常量组） */
export const REVIEW_IMAGE_PAGE_PADDING_CSS = 36;

/**
 * 常规页内容高上限（CSS px）。1500 + 上下留白 72 → 1572 逻辑高 ×2 =
 * 3144px 像素高，宽 1440 → 4.5MP，稳居各浏览器画布限额内。
 */
export const REVIEW_IMAGE_PAGE_MAX_CONTENT_HEIGHT_CSS = 1500;

/** 画布单边像素上限（保守值：兼容 iPad Safari ~4096 边长限制；暂定） */
export const REVIEW_IMAGE_CANVAS_MAX_EDGE_PX = 4096;

/** 画布总像素上限（16MP，保守值；暂定） */
export const REVIEW_IMAGE_CANVAS_MAX_AREA_PX = 16_777_216;

/**
 * 单块内容高兜底上限（CSS px）：超过常规页高的块（长图等）独立成页的最后
 * 边界。由画布上限推导（不手抄数）：min(边长约束, 面积约束)。
 */
export const REVIEW_IMAGE_SINGLE_BLOCK_MAX_CONTENT_HEIGHT_CSS = Math.floor(
  Math.min(
    REVIEW_IMAGE_CANVAS_MAX_EDGE_PX / REVIEW_IMAGE_PIXEL_RATIO -
      2 * REVIEW_IMAGE_PAGE_PADDING_CSS,
    Math.floor(
      REVIEW_IMAGE_CANVAS_MAX_AREA_PX /
        (REVIEW_IMAGE_WIDTH_CSS * REVIEW_IMAGE_PIXEL_RATIO),
    ) /
      REVIEW_IMAGE_PIXEL_RATIO -
      2 * REVIEW_IMAGE_PAGE_PADDING_CSS,
  ),
); // = 1976

/** 学生红线文案（页眉与组件共用单一来源；与面板既有口径一致） */
export const REVIEW_IMAGE_STUDENT_NOTE =
  "本合成图不含参考答案与对错判定（内容只基于你自己的作答）";

/** 教师视角页眉说明（教师域材料含答案，属文档化设计） */
export const REVIEW_IMAGE_TEACHER_NOTE =
  "教师视角（含参考答案、判定与评语，仅供核对）";

// ---------- 失败分类（显式语义，中文文案） ----------

/** 合成图导出失败分类（任务清单失败语义总则的机器可读形态） */
export type ReviewImageExportErrorKind =
  /** 学生载荷哨兵命中：拒绝生成（答案不进版式/渲染树） */
  | "forbidden"
  /** 字体嵌入失败（本地字体 CSS 收集/嵌入异常） */
  | "font"
  /** 图片解码/加载失败（配图或原稿图拿不到） */
  | "media"
  /** PNG 编码失败（空 dataUrl/空 Blob/非 PNG 魔数/整页空白） */
  | "encode"
  /** 画布尺寸超限（分页兜底后仍超浏览器画布上限） */
  | "canvas-limit"
  /** 栅格化本体失败（html-to-image 抛错等未分类失败） */
  | "rasterize";

export interface ReviewImageExportError {
  readonly kind: ReviewImageExportErrorKind;
  readonly message: string;
}

// ---------- 版式区块模型（纯函数） ----------

/** 合成图版式区块：渲染层按序产块，分页层按块高切页 */
export type ReviewImageSection =
  | {
      readonly kind: "header";
      /** 页眉标题（第 N 题 · 视角） */
      readonly title: string;
      readonly questionNo: number;
      readonly roleLabel: string;
      readonly note: string;
      /** 生成时间文案（Asia/Shanghai 口径；测试注入固定值） */
      readonly generatedAtText: string;
    }
  | {
      readonly kind: "markdown";
      /** 服务端按角色投影后的 markdown 原文（题面/选项/学生答案；教师含参考答案节） */
      readonly md: string;
    }
  | {
      readonly kind: "image";
      /** 附件直出 URL（学生/教师各自已授权的下载端点） */
      readonly src: string;
      /** 区块说明（配图/手写原稿 + 包内路径） */
      readonly caption: string;
      readonly alt: string;
    }
  | {
      readonly kind: "missing-note";
      readonly path: string;
      readonly reason: string;
    };

/** 附件分类的用户可读名（与 review-pack 面板 KIND_LABELS 同口径） */
const ATTACHMENT_KIND_LABELS: Record<string, string> = {
  media: "配图",
  evidence: "手写原稿图",
  ink: "手写作答笔迹",
};

/** 生成时间文案（Asia/Shanghai 固定口径——CI=UTC 不漂移，见 CI 环境确定性纪律） */
function formatGeneratedAt(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/** 教师模板节的哨兵前缀（服务端 review-pack-service 拼节用的固定标记） */
const TEACHER_SECTION_MARKERS = [
  "**参考答案**",
  "**详解**",
  "**判定**",
  "**老师评语**",
] as const;

/**
 * 学生载荷守卫：任一命中即拒绝生成合成图（fail-closed）——
 * - stemMdLeaksAnswers：[[答案]] 标记 / 选项任务列表（[x] 正确项），
 *   与服务端 assert-no-stem-leak 同一 oracle（md-dsl 单一实现）；
 * - 教师模板节标记：服务端学生装配结构性不含这些节，出现即投影链路破坏；
 * - answersIncluded=true：载荷不变量破坏（学生包结构性不含答案）。
 */
function assertStudentPayloadSafe(preview: ReviewPackPreviewData): void {
  if (stemMdLeaksAnswers(preview.questionMd)) {
    throw new Error(
      "学生载荷题面仍含答案标记（[[答案]] 或选项正误列表），拒绝生成学生合成图——上游角色投影缺失，请刷新后重试或使用完整包导出",
    );
  }
  for (const marker of TEACHER_SECTION_MARKERS) {
    if (preview.questionMd.includes(marker)) {
      throw new Error(
        `学生载荷题面混入教师域内容（${marker} 节），拒绝生成学生合成图——上游角色投影缺失，请刷新后重试或使用完整包导出`,
      );
    }
  }
  if (preview.answersIncluded) {
    throw new Error(
      "学生载荷声明包含参考答案（载荷不变量破坏），拒绝生成学生合成图——请刷新后重试或使用完整包导出",
    );
  }
}

/**
 * 把 review-pack 预览载荷组合为合成图版式区块（纯函数）：
 * 页眉（题号/视角/红线/时间）→ 题面 markdown → 在场图片区块（文档序）→
 * 缺失显式声明。学生角色先过守卫（答案内容不进版式模型——渲染树里自然
 * 没有，不是 display:none 式隐藏）。
 */
export function buildReviewImageSections(
  preview: ReviewPackPreviewData,
  opts: { now?: Date } = {},
): ReviewImageSection[] {
  if (preview.role === "student") {
    assertStudentPayloadSafe(preview);
  }
  const sections: ReviewImageSection[] = [];
  const note =
    preview.role === "student"
      ? preview.released
        ? REVIEW_IMAGE_STUDENT_NOTE
        : `${REVIEW_IMAGE_STUDENT_NOTE}；答案尚未公布（无判定属正常）`
      : REVIEW_IMAGE_TEACHER_NOTE;
  sections.push({
    kind: "header",
    title: `第 ${preview.questionNo} 题 · ${
      preview.role === "student" ? "学生视角" : "教师视角"
    }`,
    questionNo: preview.questionNo,
    roleLabel: preview.role === "student" ? "学生视角" : "教师视角",
    note,
    generatedAtText: formatGeneratedAt(opts.now ?? new Date()),
  });
  if (!preview.questionPresent) {
    sections.push({
      kind: "missing-note",
      path: "题目内容",
      reason: "题目内容缺失（历史快照缺失，不回填当前题库内容）",
    });
  }
  if (preview.questionMd.trim().length > 0) {
    sections.push({ kind: "markdown", md: preview.questionMd.trimEnd() });
  }
  if (preview.handwritten) {
    sections.push({
      kind: "markdown",
      md: "**作答说明**：本题手写作答，作答即笔迹（没有草稿层属正常）。",
    });
  }
  for (const attachment of preview.attachments) {
    if (attachment.state === "ready" && attachment.downloadUrl !== undefined) {
      const label = ATTACHMENT_KIND_LABELS[attachment.kind] ?? attachment.kind;
      sections.push({
        kind: "image",
        src: attachment.downloadUrl,
        caption: `${label}（${attachment.path}）`,
        alt: label,
      });
    } else {
      sections.push({
        kind: "missing-note",
        path: attachment.path,
        reason: attachment.reason ?? "未知原因",
      });
    }
  }
  return sections;
}

// ---------- 分页计划（纯几何，与 DOM 无关） ----------

/** 测量后的块度量（heightPx=块在版式流中的占位高，含与后继块的间距） */
export interface ReviewImageBlockMetric {
  readonly id: string;
  readonly heightPx: number;
}

/** 一页的分页计划：页号 + 顺序块 id + 页内容高（该页块的占位高之和） */
export interface ReviewImagePagePlan {
  readonly pageIndex: number;
  readonly blockIds: readonly string[];
  readonly contentHeightPx: number;
}

/** 分页限制（缺省用本文件常量；测试与特殊场景可注入） */
export interface ReviewImagePageLimits {
  readonly maxPageContentHeightPx?: number;
  readonly singleBlockMaxContentHeightPx?: number;
}

/**
 * 长内容分片分页（纯函数，方案 §10「长内容分页」）：
 * - 贪心装填：按块序累计，装不下下一块即开新页——页序=阅读序，块序整体
 *   保持，每块恰好归一页（不重不漏，无重叠——与 T6R.6 笔迹切片的重叠语义
 *   不同：版式切块在块边界上，无需跨页内容续读）；
 * - 单块超过常规页高但未超画布兜底上限：独立成页（不截断内容）；
 * - 单块超过画布兜底上限：抛错（分页兜底仍超限的显式失败——调用方转
 *   canvas-limit 错误，不下载残图）。
 */
export function planReviewImagePages(
  blocks: readonly ReviewImageBlockMetric[],
  limits: ReviewImagePageLimits = {},
): ReviewImagePagePlan[] {
  const maxPage =
    limits.maxPageContentHeightPx ?? REVIEW_IMAGE_PAGE_MAX_CONTENT_HEIGHT_CSS;
  const singleMax =
    limits.singleBlockMaxContentHeightPx ??
    REVIEW_IMAGE_SINGLE_BLOCK_MAX_CONTENT_HEIGHT_CSS;
  const pages: ReviewImagePagePlan[] = [];
  let currentIds: string[] = [];
  let currentHeight = 0;
  const flush = (): void => {
    if (currentIds.length === 0) return;
    pages.push({
      pageIndex: pages.length,
      blockIds: currentIds,
      contentHeightPx: currentHeight,
    });
    currentIds = [];
    currentHeight = 0;
  };
  for (const block of blocks) {
    const height = Math.max(0, block.heightPx);
    if (height > singleMax) {
      throw new Error(
        `单块内容高 ${Math.round(height)}px 超过画布分页兜底上限 ${singleMax}px，无法分页——请减少单段内容长度或分多题导出`,
      );
    }
    if (height > maxPage && currentIds.length > 0) {
      flush(); // 超常规页高的块前面先收页，让它独立成页
    }
    if (currentHeight + height > maxPage && currentIds.length > 0) {
      flush();
    }
    currentIds.push(block.id);
    currentHeight += height;
  }
  flush();
  return pages;
}

/**
 * 页面画布像素尺寸（宽=固定逻辑宽×像素比；高=（内容高+上下留白）×像素比）。
 * 超出画布边长/面积上限时抛错（显式失败原因——不静默截断）。
 */
export function reviewImageCanvasPixelSize(contentHeightCss: number): {
  width: number;
  height: number;
} {
  const width = REVIEW_IMAGE_WIDTH_CSS * REVIEW_IMAGE_PIXEL_RATIO;
  const height = Math.ceil(
    (contentHeightCss + 2 * REVIEW_IMAGE_PAGE_PADDING_CSS) *
      REVIEW_IMAGE_PIXEL_RATIO,
  );
  if (height > REVIEW_IMAGE_CANVAS_MAX_EDGE_PX) {
    throw new Error(
      `画布像素高 ${height}px 超过浏览器画布边长上限 ${REVIEW_IMAGE_CANVAS_MAX_EDGE_PX}px（分页后仍超限）——拒绝渲染`,
    );
  }
  if (width * height > REVIEW_IMAGE_CANVAS_MAX_AREA_PX) {
    throw new Error(
      `画布总像素 ${width * height} 超过浏览器画布面积上限 ${REVIEW_IMAGE_CANVAS_MAX_AREA_PX}px（分页后仍超限）——拒绝渲染`,
    );
  }
  return { width, height };
}

// ---------- 文件名 ----------

/**
 * 导出文件名：review-image-q<题号>-<视角>-<页号 2 位>.png——带题号与学生/
 * 教师视角，前缀不同于既有 review-pack zip（不冲突）；多页时 -01/-02 递增。
 */
export function reviewImageFilename(
  questionNo: number,
  role: ReviewPackRole,
  pageIndex: number,
): string {
  return `review-image-q${questionNo}-${role}-${String(pageIndex + 1).padStart(2, "0")}.png`;
}
