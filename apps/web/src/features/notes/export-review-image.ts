import "katex/dist/katex.min.css";

import type { ReviewPackPreviewData, ReviewPackRole } from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { getFontEmbedCSS, toBlob } from "html-to-image";
import { createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { REVIEW_PACK_KIND_LABELS } from "@/features/export/review-pack-kinds";
import {
  richMarkdownRehypePlugins,
  richMarkdownRemarkPlugins,
} from "@/features/markdown/pipeline";
import { saveBlobAs } from "@/lib/api";

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

/** 页面四周留白（CSS px）：页容器四向同值；测量容器取左右（内容宽与页容器一致） */
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

/**
 * image 块内非图片内容预算（CSS px）：图注按两行预留（12px 字号 ×1.5 行高
 * ×2 ≈36px）＋图注上间距 4 ＋块上下 margin 28 ＋余量 22——长路径 caption
 * （如「手写原稿图（evidence/e001-original-02.png）」）换两行不再把整块
 * 顶爆单块兜底上限（审查修复轮 P2-8）。
 */
const IMAGE_BLOCK_NON_IMAGE_BUDGET_CSS = 90;

/** image 块内图片 maxHeight（单块兜底上限减非图片预算推导，不手抄数） */
export const REVIEW_IMAGE_IMAGE_MAX_HEIGHT_CSS =
  REVIEW_IMAGE_SINGLE_BLOCK_MAX_CONTENT_HEIGHT_CSS -
  IMAGE_BLOCK_NON_IMAGE_BUDGET_CSS;

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

/**
 * 教师模板节的哨兵标记（服务端 review-pack-service 拼节用的固定粗体标记）。
 * 追加 `:::solution`/`:::answer` 指令行形态（审查修复轮 P2-5，只增不改）：
 * 若未来服务端学生投影回归、把解答指令节留在学生 questionMd 且节内无
 * [[答案]] 标记，粗体串与泄露 oracle 均不命中——指令形态是纵深防御在此
 * 场景的第二道断档补齐（渲染层会把指令容器渲染成【解答】框）。
 */
const TEACHER_SECTION_MARKERS = [
  "**参考答案**",
  "**详解**",
  "**判定**",
  "**老师评语**",
  ":::solution",
  ":::answer",
] as const;

/**
 * 服务端拼节的学生作答段前缀（static-material：`**学生答案**：…` 恒为末节）。
 */
const STUDENT_ANSWER_SECTION_PREFIX = "**学生答案**：";

/**
 * 剥离服务端拼接的学生作答段（保守剥离）：
 * - 只认「行首的 `**学生答案**：`」，从**最后一个**匹配行起截断到串尾——
 *   服务端装配恒把作答放末节，学生自由作答文本可能跨多行；
 * - 剥离只影响哨兵检测输入，不改渲染内容：学生把自己的答案写成 [[x]]/
 *   `- [x] …` 形态属作答内容（无泄露含义），不该被题面泄露 oracle 误伤成
 *   永远无法导出（审查修复轮 P2-4 假阳性）。
 */
function stripStudentAnswerSection(md: string): string {
  const idx = md.lastIndexOf(STUDENT_ANSWER_SECTION_PREFIX);
  if (idx === -1) return md;
  // 非行首（题面句子中间的同文串）不剥——保守方向：宁可误拒也不放过检测
  if (idx !== 0 && md[idx - 1] !== "\n") return md;
  return md.slice(0, idx);
}

/**
 * 学生载荷守卫：任一命中即拒绝生成合成图（fail-closed）——
 * - stemMdLeaksAnswers（对**题面部分**执行——先保守剥离服务端拼接的学生
 *   作答段）：[[答案]] 标记 / 选项任务列表（[x] 正确项），与服务端
 *   assert-no-stem-leak 同一 oracle（md-dsl 单一实现）；
 * - 教师模板节标记（对全文执行，含作答段）：服务端学生装配结构性不含这些
 *   节，出现即投影链路破坏；
 * - answersIncluded=true：载荷不变量破坏（学生包结构性不含答案）。
 */
function assertStudentPayloadSafe(preview: ReviewPackPreviewData): void {
  const stemPartMd = stripStudentAnswerSection(preview.questionMd);
  if (stemMdLeaksAnswers(stemPartMd)) {
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
      const label = REVIEW_PACK_KIND_LABELS[attachment.kind] ?? attachment.kind;
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
    // 统一累加条件：装不下即收页再装（超常规页高的块自然独立成页——
    // height > maxPage 时 currentHeight + height > maxPage 必然成立）
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

// ---------- 栅格化适配器层（需要 DOM；依赖可注入以便 jsdom 测试） ----------

/** PNG 魔数（编码校验：空输出/非 PNG 拒绝落盘） */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 页面静态版式的字体栈（本地打包字体在前；中文回退系统字体） */
const REVIEW_IMAGE_FONT_STACK =
  '"Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 注入点集合（jsdom 无布局/canvas：单测注入假实现；生产缺省走真实链路） */
export interface ReviewImageExportDeps {
  /** 收集本地字体嵌入 CSS（缺省 html-to-image getFontEmbedCSS） */
  readonly collectFontCss?: (node: HTMLElement) => Promise<string>;
  /** 预解码图片（缺省 new Image + decode；失败显式抛错） */
  readonly loadImages?: (urls: readonly string[]) => Promise<void>;
  /** 栅格化页节点（缺省 html-to-image toPng → Blob） */
  readonly rasterizeNode?: (
    node: HTMLElement,
    opts: {
      readonly cssWidth: number;
      readonly cssHeight: number;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
    },
  ) => Promise<Blob>;
  /** 采样判断 PNG 是否整页空白（缺省 Image+Canvas 采样） */
  readonly samplePngBlank?: (blob: Blob) => Promise<boolean>;
  /** 保存 PNG（缺省 saveBlobAs anchor 下载） */
  readonly savePng?: (blob: Blob, filename: string) => void;
  /** 块高度测量（缺省真实布局测量；jsdom 无布局由测试注入） */
  readonly measureBlockHeights?: (blockCount: number) => number[];
  /**
   * 单步异步超时毫秒（缺省 REVIEW_IMAGE_ASYNC_STEP_TIMEOUT_MS；测试注入短值
   * 加速挂起路径——不依赖假定时器，React 提交走 MessageChannel 不受其推进）。
   */
  readonly stepTimeoutMs?: number;
}

/** 导出结果：成功=逐页文件清单（含 blob 供「复制图片」辅助出口复用）；失败=分类错误（零下载） */
export type ReviewImageExportResult =
  | {
      readonly ok: true;
      readonly pages: ReadonlyArray<{
        filename: string;
        bytes: number;
        blob: Blob;
      }>;
    }
  | { readonly ok: false; readonly error: ReviewImageExportError };

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 单步异步超时（ms）：字体收集 / 图片预解码（全局与逐页）/ 逐页栅格化各自
 * 限时。iOS Safari 与旧 WebKit 存在 decode()/canvas 挂起、promise 永不
 * settle 的已知怪癖——不限时会让导出按钮永久停在「正在生成」（审查修复轮
 * P1-3）；超时按所在步骤转 font/media/rasterize 分类失败（零下载、可回落）。
 */
export const REVIEW_IMAGE_ASYNC_STEP_TIMEOUT_MS = 30_000;

/** 超时兜底：正常先到则透传其结果/错误，并清理定时器 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function errOf(
  kind: ReviewImageExportErrorKind,
  message: unknown,
): ReviewImageExportResult {
  return {
    ok: false,
    error: {
      kind,
      message:
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message),
    },
  };
}

// ---------- 静态 markdown 渲染（与 RichMarkdown 同一 remark/rehype 管线，宿主组件换静态版） ----------

/** react-markdown 注入的 hast 元素（本层只读 properties.directive） */
interface HastNodeLike {
  readonly properties?: Record<string, unknown>;
}

/** 从宿主标签属性还原指令名（与 directives/index.tsx readDirective 同源字段） */
function directiveNameOf(node: unknown): string {
  const directive = (node as HastNodeLike | null)?.properties?.directive;
  return typeof directive === "string" ? directive : "";
}

/** 块级容器的静态标签（折叠块/分步等在合成图里永远展开呈现） */
const STATIC_CONTAINER_LABELS: Record<string, string> = {
  question: "题目",
  hint: "提示",
  answer: "答案",
  solution: "解答",
  example: "例",
  steps: "分步",
  step: "步骤",
  fold: "折叠块",
  tip: "提示",
  warning: "注意",
  box: "框注",
  columns: "分栏",
  col: "栏",
};

/** 静态块级容器宿主：内容恒展开（交互状态本就未记录，静态标记行已在材料里） */
function StaticDirectiveContainer({
  node,
  children,
}: {
  node?: unknown;
  children?: ReactNode;
}): ReactElement {
  const label = STATIC_CONTAINER_LABELS[directiveNameOf(node)];
  return createElement(
    "div",
    {
      style: {
        margin: "10px 0",
        padding: "10px 14px",
        borderLeft: "3px solid #94a3b8",
        background: "#f1f5f9",
        borderRadius: "4px",
      },
    },
    label !== undefined
      ? createElement(
          "div",
          {
            style: { fontSize: "12px", color: "#475569", marginBottom: "6px" },
          },
          `【${label}】`,
        )
      : null,
    children,
  );
}

/** 静态叶子指令宿主：::image 指向下方附件区块；其余以文字说明降级 */
function StaticDirectiveLeaf({ node }: { node?: unknown }): ReactElement {
  const name = directiveNameOf(node);
  const text =
    name === "image"
      ? "【配图】见下方图片附件区块"
      : `【${name.length > 0 ? name : "指令"}】交互内容以静态材料说明为准`;
  return createElement(
    "p",
    { style: { margin: "8px 0", fontSize: "13px", color: "#475569" } },
    text,
  );
}

/** 静态行内指令宿主：blank=下划线空框；mark=高亮；其余按原文呈现 */
function StaticDirectiveText({
  node,
  children,
}: {
  node?: unknown;
  children?: ReactNode;
}): ReactElement {
  const name = directiveNameOf(node);
  if (name === "blank") {
    return createElement("span", {
      style: {
        display: "inline-block",
        minWidth: "3em",
        borderBottom: "1.5px solid #64748b",
        height: "1em",
      },
    });
  }
  if (name === "mark") {
    return createElement(
      "span",
      {
        style: { background: "#fef08a", padding: "0 2px", borderRadius: "2px" },
      },
      children,
    );
  }
  return createElement("span", null, children);
}

/**
 * 与 RichMarkdown 同一套管线（解析口径一致，插件清单单一来源
 * features/markdown/pipeline.ts——审查修复轮：此前两处重复手写同一配置）；
 * 宿主组件换成上面的静态版。
 */
const staticComponents = {
  "directive-container": StaticDirectiveContainer,
  "directive-leaf": StaticDirectiveLeaf,
  "directive-text": StaticDirectiveText,
} as unknown as Parameters<typeof ReactMarkdown>[0]["components"];

/** 单段 markdown 的静态渲染（.rich-markdown 全局排版样式与主应用一致） */
function StaticMarkdown({ md }: { md: string }): ReactElement {
  return createElement(
    "div",
    { className: "rich-markdown" },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: richMarkdownRemarkPlugins,
        rehypePlugins: richMarkdownRehypePlugins,
        components: staticComponents,
      },
      md,
    ),
  );
}

// ---------- 版式区块 → DOM ----------

/** 区块统一外壳：margin 0（间距靠内部 padding/元素自身 margin，避免跨页边距歧义） */
function blockShell(
  attrs: Record<string, string>,
  style: Record<string, string>,
  ...children: ReactNode[]
): ReactElement {
  return createElement(
    "div",
    { ...attrs, style: { margin: "0", ...style } },
    ...children,
  );
}

function renderSectionElement(section: ReviewImageSection): ReactElement {
  switch (section.kind) {
    case "header":
      return blockShell(
        { "data-export-block": "header" },
        {
          borderBottom: "2px solid #0f172a",
          paddingBottom: "10px",
          marginBottom: "14px",
        },
        createElement(
          "div",
          { style: { fontSize: "20px", fontWeight: "700" } },
          section.title,
        ),
        createElement(
          "div",
          { style: { fontSize: "13px", color: "#475569", marginTop: "4px" } },
          `${section.note} · 生成时间 ${section.generatedAtText}`,
        ),
      );
    case "markdown":
      // 包一层 flow-root 容器防止内部 margin 外溢；分页前拆为逐元素块
      return blockShell(
        { "data-export-md-wrap": "" },
        { display: "flow-root" },
        createElement(StaticMarkdown, { md: section.md }),
      );
    case "image":
      // maxHeight 兜底：超高图等比缩到单块兜底上限内（仍超即 canvas-limit 显式失败）
      return blockShell(
        { "data-export-block": "image", "data-kind": "figure" },
        { margin: "14px 0", textAlign: "center" },
        createElement("img", {
          src: section.src,
          alt: section.alt,
          style: {
            maxWidth: "100%",
            maxHeight: `${REVIEW_IMAGE_IMAGE_MAX_HEIGHT_CSS}px`,
            objectFit: "contain",
            display: "block",
            margin: "0 auto",
          },
        }),
        createElement(
          "div",
          { style: { fontSize: "12px", color: "#64748b", marginTop: "4px" } },
          section.caption,
        ),
      );
    case "missing-note":
      return blockShell(
        { "data-export-block": "missing-note" },
        {
          margin: "10px 0",
          padding: "8px 12px",
          border: "1px solid #fbbf24",
          background: "#fffbeb",
          borderRadius: "4px",
          fontSize: "13px",
          color: "#92400e",
        },
        `缺失：${section.path} —— ${section.reason}`,
      );
  }
}

/** 单个版式区块（keyed 包装：列表渲染需要稳定 key，DOM 与无 key 版一致） */
function KeyedSection({
  section,
}: {
  section: ReviewImageSection;
}): ReactElement {
  return renderSectionElement(section);
}

/**
 * 渲染完成信号（callback ref 在 commit 时触发——等待 React 真正挂载）。
 *
 * 测量几何必须与页容器一致（审查修复轮 P0-1）：720 边框盒 − 左右留白 36×2
 * = 648 内容宽——跨行段落在两处换行口径相同，测量高才等于真实渲染高。
 * 上下留白不进测量容器：offsetTop 差值口径只看块间差，页高已按 +72 预算。
 */
function ExportContentRoot({
  sections,
  onMounted,
}: {
  sections: readonly ReviewImageSection[];
  onMounted: () => void;
}): ReactElement {
  return createElement(
    "div",
    {
      "data-export-content": "",
      ref: onMounted,
      style: {
        position: "relative",
        background: "#ffffff",
        boxSizing: "border-box",
        width: `${REVIEW_IMAGE_WIDTH_CSS}px`,
        paddingLeft: `${REVIEW_IMAGE_PAGE_PADDING_CSS}px`,
        paddingRight: `${REVIEW_IMAGE_PAGE_PADDING_CSS}px`,
      },
    },
    sections.map((section, i) =>
      createElement(KeyedSection, { key: `s${i}`, section }),
    ),
  );
}

/** root.render + 等待 commit（callback ref resolve） */
function renderExportContent(
  root: Root,
  sections: readonly ReviewImageSection[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      root.render(
        createElement(ExportContentRoot, {
          sections,
          onMounted: () => resolve(),
        }),
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * 拆 markdown 包装层：markdown 区块实际渲染为
 * [data-export-md-wrap] > div.rich-markdown > 顶层元素（p/h3/ul/…）——
 * 逐顶层元素包进 carry class 的薄壳（margin 可穿透薄壳照常折叠），使
 * markdown 逐段可分页（整段 stem 成一块时长题干永远无法分页）。
 */
function unwrapMarkdownWrappers(content: HTMLElement): void {
  for (const wrap of [
    ...content.querySelectorAll<HTMLElement>("[data-export-md-wrap]"),
  ]) {
    const parent = wrap.parentElement;
    if (parent === null) continue;
    const mdRoot = wrap.querySelector<HTMLElement>(":scope > .rich-markdown");
    for (const child of [...(mdRoot ?? wrap).children]) {
      const shell = document.createElement("div");
      shell.setAttribute("data-export-md-block", "");
      shell.className = "rich-markdown";
      shell.appendChild(child);
      parent.insertBefore(shell, wrap);
    }
    wrap.remove();
  }
}

/** 真实布局测量：块高=流内占位（相邻块 offsetTop 差；末块到内容底） */
function measureBlockExtents(
  content: HTMLElement,
  blockNodes: readonly HTMLElement[],
): number[] {
  const total = content.scrollHeight;
  return blockNodes.map((node, i) => {
    const next = blockNodes[i + 1];
    const end = next !== undefined ? next.offsetTop : total;
    return Math.max(0, end - node.offsetTop);
  });
}

/** 组装一页 DOM：把该页块节点移入页容器（每块恰归一页——不重不漏） */
function buildPageNode(
  host: HTMLElement,
  plan: ReviewImagePagePlan,
  blockNodes: readonly HTMLElement[],
): HTMLElement {
  const page = document.createElement("div");
  page.setAttribute("data-review-image-page", String(plan.pageIndex));
  Object.assign(page.style, {
    width: `${REVIEW_IMAGE_WIDTH_CSS}px`,
    boxSizing: "border-box",
    padding: `${REVIEW_IMAGE_PAGE_PADDING_CSS}px`,
    height: `${plan.contentHeightPx + 2 * REVIEW_IMAGE_PAGE_PADDING_CSS}px`,
    background: "#ffffff",
    display: "flow-root",
    fontFamily: REVIEW_IMAGE_FONT_STACK,
    fontSize: "16px",
    lineHeight: "1.75",
    color: "#0f172a",
  });
  for (const id of plan.blockIds) {
    const node = blockNodes[Number(id.slice(1))];
    if (node !== undefined) page.appendChild(node); // appendChild=移动（从内容流摘出）
  }
  // 页首块 margin-top 归零（审查修复轮 P1-2）：测量口径是块间 offsetTop 差
  // （不含块自身 margin-top，测量容器无 BFC 时折叠穿透不计入）；页容器
  // flow-root 的 BFC 全额包含页首块 margin——不归零每页实际高度超出预算
  // 8–14px，页底最后一行会被固定页高视口裁掉。
  const first = page.firstElementChild as HTMLElement | null;
  if (first !== null) first.style.marginTop = "0";
  host.appendChild(page);
  return page;
}

// ---------- 缺省依赖实现（真实浏览器链路） ----------

/** 预解码图片：decode 优先（等待解码完成），旧环境回退 load 事件 */
async function preloadImages(urls: readonly string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          const image = new Image();
          const fail = (): void => reject(new Error(`图片加载失败：${url}`));
          if (typeof image.decode === "function") {
            image.src = url;
            image.decode().then(
              () => resolve(),
              () => fail(),
            );
          } else {
            image.onload = () => resolve();
            image.onerror = () => fail();
            image.src = url;
          }
        }),
    ),
  );
}

/**
 * html-to-image 栅格化：原生 toBlob 直出 Blob——不经 toPng 巨型 Base64 字符串
 * →fetch 反解的中间层（审查修复轮内存驻留收敛：单页数十 MB 的 Base64 文本
 * 与二进制不再同时驻留）。null（画布 0×0 等）与空 Blob 转栅格化失败；
 * PNG 魔数与空白校验链路对 Blob 照常生效。
 */
async function rasterizePageWithHtmlToImage(
  node: HTMLElement,
  cssHeight: number,
  fontCss: string,
): Promise<Blob> {
  const blob = await toBlob(node, {
    width: REVIEW_IMAGE_WIDTH_CSS,
    height: Math.ceil(cssHeight),
    pixelRatio: REVIEW_IMAGE_PIXEL_RATIO,
    backgroundColor: "#ffffff",
    fontEmbedCSS: fontCss,
  });
  if (blob === null || blob.size === 0) {
    throw new Error("栅格化未产出 PNG 数据");
  }
  return blob;
}

/** Blob 是否 PNG 魔数形状（空输出/非 PNG 在此拦截） */
async function pngBlobHasMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return PNG_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * 内存采样判定：RGBA 数据全部采样点纯白/透明 → 判空白（页面恒有页眉文字，
 * 文字必有灰阶像素）。缩到 64×64 后文本仍保留灰阶，判定强度与全图网格采样
 * 等价。
 */
export function rgbaSampleAllBlank(data: Uint8ClampedArray): boolean {
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // 透明像素不计
    if (!(data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)) {
      return false;
    }
  }
  return true;
}

/**
 * 采样判断整页空白（「不下载空白 PNG 后显示成功」的产物侧防线）：整页绘制
 * 缩到 64×64 离屏小画布后**单次** getImageData 读回、内存里取样判断——
 * 逐像素 getImageData 是 4096 次同步 GPU 读回，在 iPad WebKit 会引发整机
 * 卡顿（审查修复轮 HIGH）。画布不可用时不误杀（返回非空白）。
 */
async function samplePngBlank(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("空白校验图加载失败"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return false;
    ctx.drawImage(image, 0, 0, 64, 64);
    return rgbaSampleAllBlank(ctx.getImageData(0, 0, 64, 64).data);
  } catch {
    return false; // 校验链路故障不误杀（魔数/空白另有 encode 分类兜底）
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 主流程 ----------

/**
 * 空页防御（gemini 审查补漏 LOW-3）：分页产出零页（版式没有任何块——当前
 * 版式模型恒有页眉块，此为 DOM 层防御分支）时显式失败，绝不静默「成功」。
 */
export function emptyReviewImagePagesResult(): ReviewImageExportResult {
  return errOf("rasterize", "合成图内容为空，未生成任何页面");
}

/**
 * 导出合成图（适配器主流程）：
 * 模型守卫 → 字体嵌入 → 图片预解码 → 离屏渲染 → 测量分页 → 逐页栅格化
 * + 产物校验（魔数/空白）→ 全部通过后统一下载。任一步失败返回分类错误且
 * **零下载**；离屏宿主必然清理（成功/失败同路径）。
 */
export async function exportReviewImages(
  preview: ReviewPackPreviewData,
  deps: ReviewImageExportDeps = {},
): Promise<ReviewImageExportResult> {
  let sections: readonly ReviewImageSection[];
  try {
    sections = buildReviewImageSections(preview);
  } catch (err) {
    return errOf("forbidden", err);
  }
  if (typeof document === "undefined") {
    return errOf("rasterize", "合成图导出需要浏览器环境（当前环境无 DOM）");
  }

  const host = document.createElement("div");
  host.setAttribute("data-review-image-host", "");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    width: `${REVIEW_IMAGE_WIDTH_CSS}px`,
    background: "#ffffff",
    zIndex: "-1",
  });
  document.body.appendChild(host);
  let root: Root | null = null;
  const loadImageFn =
    deps.loadImages !== undefined ? deps.loadImages : preloadImages;
  const stepTimeoutMs =
    deps.stepTimeoutMs ?? REVIEW_IMAGE_ASYNC_STEP_TIMEOUT_MS;
  try {
    // ① 本地字体嵌入（KaTeX/正文字体随构建本地打包；嵌入失败/收集挂起超时同分类显式放弃）
    let fontCss: string;
    try {
      fontCss = await withTimeout(
        deps.collectFontCss !== undefined
          ? deps.collectFontCss(document.body)
          : getFontEmbedCSS(document.body),
        stepTimeoutMs,
        `本地字体收集超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
      );
    } catch (err) {
      return errOf(
        "font",
        `本地字体嵌入失败（${msgOf(err)}）——公式/文字可能缺字，已放弃导出；可继续使用「下载完整包」出口`,
      );
    }
    try {
      await withTimeout(
        Promise.resolve(document.fonts.ready),
        stepTimeoutMs,
        "document.fonts.ready 等待超时",
      );
    } catch {
      // 旧环境 fonts 集不可等待或挂起：字体嵌入失败已有独立分类，这里不阻断
    }

    // ② 图片预解码（测量高度需要图片真实尺寸；失败/挂起超时显式列出来源）
    const imageSrcs = sections
      .filter(
        (s): s is Extract<ReviewImageSection, { kind: "image" }> =>
          s.kind === "image",
      )
      .map((s) => s.src);
    if (imageSrcs.length > 0) {
      try {
        await withTimeout(
          loadImageFn(imageSrcs),
          stepTimeoutMs,
          `图片解码超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
        );
      } catch (err) {
        return errOf(
          "media",
          `配图/原稿图片加载失败（${msgOf(err)}）——权限可能过期或网络异常，已放弃导出；可继续使用「逐张下载」出口`,
        );
      }
    }

    // ③ 离屏渲染（React 挂载到固定宽容器；commit 后拆 markdown 块）
    const reactHost = document.createElement("div");
    host.appendChild(reactHost);
    root = createRoot(reactHost);
    await renderExportContent(root, sections);
    const content = reactHost.querySelector<HTMLElement>(
      "[data-export-content]",
    );
    if (content === null) {
      return errOf("rasterize", "离屏内容构建失败（未找到内容根节点）");
    }
    unwrapMarkdownWrappers(content);
    const blockNodes = [...content.children] as HTMLElement[];

    // ④ 测量 + 分页（单块超兜底上限 → canvas-limit 显式失败）
    const heights =
      deps.measureBlockHeights !== undefined
        ? deps.measureBlockHeights(blockNodes.length)
        : measureBlockExtents(content, blockNodes);
    let pages: readonly ReviewImagePagePlan[];
    try {
      pages = planReviewImagePages(
        blockNodes.map((_, i) => ({
          id: `b${i}`,
          heightPx: heights[i] ?? 0,
        })),
      );
    } catch (err) {
      return errOf("canvas-limit", msgOf(err));
    }
    if (pages.length === 0) {
      return emptyReviewImagePagesResult();
    }

    // ⑤ 逐页栅格化 + 产物校验（先全部通过，再统一下载——失败零下载）
    const rendered: Array<{ pageIndex: number; blob: Blob }> = [];
    for (const plan of pages) {
      const cssHeight =
        plan.contentHeightPx + 2 * REVIEW_IMAGE_PAGE_PADDING_CSS;
      let pixel: { width: number; height: number };
      try {
        pixel = reviewImageCanvasPixelSize(plan.contentHeightPx);
      } catch (err) {
        return errOf("canvas-limit", msgOf(err));
      }
      const pageNode = buildPageNode(host, plan, blockNodes);
      // 页内图片再等一轮（块移动后仍同一批 URL，缓存命中近零成本）
      const pageImageSrcs = [
        ...pageNode.querySelectorAll<HTMLImageElement>("img"),
      ]
        .map((img) => img.getAttribute("src") ?? "")
        .filter((src) => src.length > 0);
      if (pageImageSrcs.length > 0) {
        try {
          await withTimeout(
            loadImageFn(pageImageSrcs),
            stepTimeoutMs,
            `页面图片等待超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
          );
        } catch (err) {
          return errOf("media", `页面图片等待失败（${msgOf(err)}）`);
        }
      }
      let blob: Blob;
      try {
        blob = await withTimeout(
          deps.rasterizeNode !== undefined
            ? deps.rasterizeNode(pageNode, {
                cssWidth: REVIEW_IMAGE_WIDTH_CSS,
                cssHeight,
                pixelWidth: pixel.width,
                pixelHeight: pixel.height,
              })
            : rasterizePageWithHtmlToImage(pageNode, cssHeight, fontCss),
          stepTimeoutMs,
          `栅格化超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
        );
      } catch (err) {
        return errOf(
          "rasterize",
          `合成图栅格化失败（${msgOf(err)}）——已放弃导出；可继续使用「下载完整包」出口`,
        );
      }
      if (!(await pngBlobHasMagic(blob))) {
        return errOf(
          "encode",
          `第 ${plan.pageIndex + 1} 页 PNG 编码失败（空输出或非 PNG）——不下载残缺文件`,
        );
      }
      const blank =
        deps.samplePngBlank !== undefined
          ? await deps.samplePngBlank(blob)
          : await samplePngBlank(blob);
      if (blank) {
        return errOf(
          "encode",
          `第 ${plan.pageIndex + 1} 页栅格化为空白图片（字体或渲染失败）——不下载空白图`,
        );
      }
      rendered.push({ pageIndex: plan.pageIndex, blob });
    }

    // ⑥ 统一下载（全部校验通过才触发）
    const out = rendered.map(({ pageIndex, blob }) => {
      const filename = reviewImageFilename(
        preview.questionNo,
        preview.role,
        pageIndex,
      );
      if (deps.savePng !== undefined) {
        deps.savePng(blob, filename);
      } else {
        saveBlobAs(blob, filename);
      }
      return { filename, bytes: blob.size, blob };
    });
    return { ok: true, pages: out };
  } catch (err) {
    return errOf("rasterize", `合成图导出失败（${msgOf(err)}）`);
  } finally {
    if (root !== null) {
      try {
        root.unmount();
      } catch {
        // 块节点已被移入页容器：React 清理失败不影响宿主整体移除
      }
    }
    host.remove();
  }
}
