import "katex/dist/katex.min.css";

import {
  ANNOTATION_BASE_MAX_HEIGHT_PX,
  ANNOTATION_BASE_WIDTH_PX,
  type AnnotationBasePreviewData,
} from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { getFontEmbedCSS, toBlob } from "html-to-image";
import { createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { rgbaSampleAllBlank } from "@/features/notes/export-review-image";
import {
  richMarkdownRehypePlugins,
  richMarkdownRemarkPlugins,
} from "@/features/markdown/pipeline";

/**
 * 题干标注底图生成管线（T6R.20，方案 §10「固定底图＋独立矢量标注」）：
 * 把学生 stem 级装配载荷（AnnotationBasePreviewData——服务端 assembleAnnotationBase
 * 产物，已剥学生答案节与全部教师节）栅格化为**单张固定宽度 PNG**，作为学生
 * 圈画题干的坐标底图。两阶段 gate 的第二阶段（客户端栅格化）：
 * POST base 取载荷 → 本管线产 PNG → POST base/image 回传落盘。
 *
 * 与 T6R.19 合成图管线（features/notes/export-review-image）的关系：
 * - **复用**其机制骨架（可注入依赖 ReviewImageExportDeps 风格、离屏测量/
 *   字体嵌入/画布预算/PNG 魔数与空白校验、单步异步超时、静态指令宿主与
 *   RichMarkdown 同一管线）；
 * - **参数化差异**（本管线的身份，见测试锁定）：
 *   1) 输入是 AnnotationBasePreviewData（无 attachments/handwritten/released
 *      等复习包概念）；
 *   2) 版式只有 页眉＋题面 markdown——无学生答案节、无任何教师节、无附件
 *      区块、无缺失声明；
 *   3) **单页不分页**：宽恒 1440px（720 CSS×2，契约 ANNOTATION_BASE_WIDTH_PX
 *      单源）；内容高上限 1976 CSS（4096 像素高上限推导）——超高题**显式
 *      禁用标注并说明原因**（草稿照用），绝不截断内容或静默分页；
 *   4) ::image 指令渲染为**真实图片**（底图是唯一呈现面，没有「附件区」可
 *      指引；mediaSrcs 预解码保证测量高度真实）。
 * - T6R.19 既有导出行为零改动（本文件不 import 其内部，只共用已导出原语）。
 *
 * ⚠️ 尺寸常量为暂定值（对齐 T6R.19 定标口径），真机定标后随契约常量修订。
 */

// ---------- 版式常量（由契约推导，不抄数） ----------

/** 底图像素宽（契约单源 re-export：上传回传与服务端校验同值口径） */
export { ANNOTATION_BASE_WIDTH_PX } from "@tutor/contract";

/** 像素比（2x：与 T6R.19 REVIEW_IMAGE_PIXEL_RATIO 同口径；题面小字可读） */
export const ANNOTATION_BASE_PIXEL_RATIO = 2;

/** 底图 CSS 逻辑宽（= 契约像素宽 / 像素比；720） */
export const ANNOTATION_BASE_WIDTH_CSS =
  ANNOTATION_BASE_WIDTH_PX / ANNOTATION_BASE_PIXEL_RATIO;

/** 页面四周留白（CSS px；与 T6R.19 页容器同值口径） */
export const ANNOTATION_BASE_PAGE_PADDING_CSS = 36;

/**
 * 内容高上限（CSS px）：像素高上限 4096 / 像素比 − 上下留白 = 1976。
 * 超限题显式禁用标注（设计兜底：「无法生成底图则该题禁用自由圈画」）。
 */
export const ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS = Math.floor(
  ANNOTATION_BASE_MAX_HEIGHT_PX / ANNOTATION_BASE_PIXEL_RATIO -
    2 * ANNOTATION_BASE_PAGE_PADDING_CSS,
); // = 1976

/** 底图内嵌图片的 maxHeight（CSS px）：上限内留图注余量 */
const IMAGE_MAX_HEIGHT_CSS = ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS - 90;

// ---------- 失败分类 ----------

/** 底图生成失败分类（机器可读；调用方据此显示禁用原因或重试） */
export type AnnotationBaseRenderErrorKind =
  /** 学生载荷哨兵命中（纵深防御第二道，同 T6R.19 口径） */
  | "forbidden"
  /** 题面超高：显式禁用标注（草稿照用）——业务性结果而非故障 */
  | "too-tall"
  /** 字体嵌入失败 */
  | "font"
  /** 图片解码/加载失败 */
  | "media"
  /** PNG 编码失败（空 dataUrl/非 PNG 魔数/整页空白） */
  | "encode"
  /** 画布尺寸超限（防御兜底；正常路径 too-tall 先拦截） */
  | "canvas-limit"
  /** 栅格化本体失败（html-to-image 抛错等未分类失败） */
  | "rasterize";

export interface AnnotationBaseRenderError {
  readonly kind: AnnotationBaseRenderErrorKind;
  readonly message: string;
}

// ---------- 版式区块模型（纯函数） ----------

/** 底图版式区块：只有页眉与题面 markdown（参数化差异 2） */
export type AnnotationBaseSection =
  | {
      readonly kind: "header";
      readonly title: string;
      readonly questionNo: number;
      readonly note: string;
      readonly generatedAtText: string;
    }
  | { readonly kind: "markdown"; readonly md: string };

/** 生成时间文案（Asia/Shanghai 固定口径——CI=UTC 不漂移，CI 环境确定性纪律） */
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

/** 教师模板节哨兵（与 export-review-image TEACHER_SECTION_MARKERS 同集口径） */
const TEACHER_SECTION_MARKERS = [
  "**参考答案**",
  "**详解**",
  "**判定**",
  "**老师评语**",
  ":::solution",
  ":::answer",
] as const;

/**
 * 学生载荷守卫（纵深防御第二道；权威哨兵在服务端 materialOf）：
 * 题面含 [[答案]]/选项任务列表（stemMdLeaksAnswers）或教师节标记 →
 * 抛错拒绝生成——答案内容不进版式模型，更不进渲染树。
 */
function assertAnnotationPayloadSafe(preview: AnnotationBasePreviewData): void {
  if (stemMdLeaksAnswers(preview.questionMd)) {
    throw new Error(
      "标注底图载荷仍含答案标记（[[答案]] 或选项正误列表），拒绝生成——上游角色投影缺失，请刷新后重试",
    );
  }
  for (const marker of TEACHER_SECTION_MARKERS) {
    if (preview.questionMd.includes(marker)) {
      throw new Error(
        `标注底图载荷混入教师域内容（${marker} 节），拒绝生成——上游角色投影缺失，请刷新后重试`,
      );
    }
  }
}

/** 底图页眉红线文案（学生视角恒定：底图只含题面） */
export const ANNOTATION_BASE_NOTE =
  "题干标注底图（只含题面与选项，不含参考答案）";

/**
 * 装配载荷 → 底图版式区块（纯函数）：页眉（题号/红线/时间）→ 题面 markdown。
 */
export function buildAnnotationBaseSections(
  preview: AnnotationBasePreviewData,
  opts: { now?: Date } = {},
): AnnotationBaseSection[] {
  assertAnnotationPayloadSafe(preview);
  const sections: AnnotationBaseSection[] = [
    {
      kind: "header",
      title: `第 ${preview.questionNo} 题 · 题干标注底图`,
      questionNo: preview.questionNo,
      note: ANNOTATION_BASE_NOTE,
      generatedAtText: formatGeneratedAt(opts.now ?? new Date()),
    },
  ];
  if (preview.questionMd.trim().length > 0) {
    sections.push({ kind: "markdown", md: preview.questionMd.trimEnd() });
  }
  return sections;
}

// ---------- 单页高计划（纯几何；与 DOM 无关） ----------

/** 测量后的块度量（heightPx=块在版式流中的占位高） */
export interface AnnotationBaseBlockMetric {
  readonly id: string;
  readonly heightPx: number;
}

/** 单页计划结果：成功=内容高；失败=显式禁用原因（超高题禁用标注） */
export type AnnotationBaseHeightPlan =
  | { readonly ok: true; readonly contentHeightCss: number }
  | { readonly ok: false; readonly reason: string };

/**
 * 底图单页高计划（参数化差异 3：不分页）：总高超上限 → 显式禁用原因
 * （调用方据此禁用标注入口并说明，草稿照用）。
 */
export function planAnnotationBaseHeight(
  blocks: readonly AnnotationBaseBlockMetric[],
): AnnotationBaseHeightPlan {
  let total = 0;
  for (const block of blocks) total += Math.max(0, block.heightPx);
  if (total > ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS) {
    return {
      ok: false,
      reason: `该题题干过长（约 ${Math.round(total)} CSS px，上限 ${ANNOTATION_BASE_MAX_CONTENT_HEIGHT_CSS}），无法生成标注底图——本题已禁用题干标注，草稿纸不受影响，可照常使用`,
    };
  }
  return { ok: true, contentHeightCss: total };
}

/** 底图画布像素尺寸（宽恒 1440；高超像素上限抛中文错误——防御兜底） */
export function annotationBaseCanvasPixelSize(contentHeightCss: number): {
  width: number;
  height: number;
} {
  const width = ANNOTATION_BASE_WIDTH_PX;
  const height = Math.ceil(
    (contentHeightCss + 2 * ANNOTATION_BASE_PAGE_PADDING_CSS) *
      ANNOTATION_BASE_PIXEL_RATIO,
  );
  if (height > ANNOTATION_BASE_MAX_HEIGHT_PX) {
    throw new Error(
      `底图像素高 ${height}px 超过上限 ${ANNOTATION_BASE_MAX_HEIGHT_PX}px（超高题应已禁用标注）`,
    );
  }
  return { width, height };
}

// ---------- 栅格化适配器层（需要 DOM；依赖可注入以便 jsdom 测试） ----------

/** PNG 魔数（编码校验） */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 底图版式的字体栈（与 T6R.19 页面同栈：本地打包字体在前） */
const ANNOTATION_BASE_FONT_STACK =
  '"Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 注入点集合（jsdom 无布局/canvas：单测注入假实现；生产缺省走真实链路） */
export interface AnnotationBaseRenderDeps {
  /** 收集本地字体嵌入 CSS（缺省 html-to-image getFontEmbedCSS） */
  readonly collectFontCss?: (node: HTMLElement) => Promise<string>;
  /** 预解码图片（缺省 new Image + decode；失败显式抛错） */
  readonly loadImages?: (urls: readonly string[]) => Promise<void>;
  /** 栅格化页节点（缺省 html-to-image toBlob → Blob） */
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
  /** 块高度测量（缺省真实布局测量；jsdom 无布局由测试注入） */
  readonly measureBlockHeights?: (blockCount: number) => number[];
  /** 单步异步超时毫秒（缺省 30s；测试注入短值加速挂起路径） */
  readonly stepTimeoutMs?: number;
}

/** 生成结果：成功=单张 PNG（含像素尺寸，上传与画布挂载共用） */
export type AnnotationBaseRenderResult =
  | {
      readonly ok: true;
      readonly blob: Blob;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
    }
  | { readonly ok: false; readonly error: AnnotationBaseRenderError };

function errOf(
  kind: AnnotationBaseRenderErrorKind,
  message: unknown,
): AnnotationBaseRenderResult {
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

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单步异步超时（同 T6R.19 口径：iOS/旧 WebKit 挂起防线，超时转分类失败） */
export const ANNOTATION_BASE_STEP_TIMEOUT_MS = 30_000;

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

// ---------- 静态 markdown 渲染（同一 remark/rehype 管线；宿主为底图静态版） ----------

/** react-markdown 注入的 hast 元素（本层只读 properties） */
interface HastNodeLike {
  readonly properties?: Record<string, unknown>;
}

function directiveNameOf(node: unknown): string {
  const directive = (node as HastNodeLike | null)?.properties?.directive;
  return typeof directive === "string" ? directive : "";
}

function attrOf(node: unknown, key: string): string | undefined {
  const value = (node as HastNodeLike | null)?.properties?.[key];
  return typeof value === "string" ? value : undefined;
}

/** 块级容器静态标签（折叠块/分步等永远展开；材料已含静态说明行） */
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
          { style: { fontSize: "12px", color: "#475569", marginBottom: "6px" } },
          `【${label}】`,
        )
      : null,
    children,
  );
}

/**
 * ::image 归一化（Media.tsx 同口径：blobs/ 开头 → 根相对 URL）。
 * 底图没有「附件区」可指引——图片直接进底图（参数化差异 4）。
 */
function normalizeImageSrc(src: string): string {
  return src.startsWith("blobs/") ? `/${src}` : src;
}

function StaticDirectiveLeaf({ node }: { node?: unknown }): ReactElement {
  const name = directiveNameOf(node);
  if (name === "image") {
    const src = attrOf(node, "src")?.trim();
    if (src !== undefined && src.length > 0) {
      return createElement("img", {
        src: normalizeImageSrc(src),
        alt: attrOf(node, "alt")?.trim() || "图片",
        style: {
          maxWidth: "100%",
          maxHeight: `${IMAGE_MAX_HEIGHT_CSS}px`,
          objectFit: "contain",
          display: "block",
          margin: "8px auto",
        },
      });
    }
    return createElement(
      "p",
      { style: { margin: "8px 0", fontSize: "13px", color: "#475569" } },
      "【配图】图片路径缺失",
    );
  }
  return createElement(
    "p",
    { style: { margin: "8px 0", fontSize: "13px", color: "#475569" } },
    `【${name.length > 0 ? name : "指令"}】交互内容以静态材料说明为准`,
  );
}

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

const staticComponents = {
  "directive-container": StaticDirectiveContainer,
  "directive-leaf": StaticDirectiveLeaf,
  "directive-text": StaticDirectiveText,
} as unknown as Parameters<typeof ReactMarkdown>[0]["components"];

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

function renderSectionElement(section: AnnotationBaseSection): ReactElement {
  switch (section.kind) {
    case "header":
      return createElement(
        "div",
        {
          "data-export-block": "header",
          style: {
            margin: "0",
            borderBottom: "2px solid #0f172a",
            paddingBottom: "10px",
            marginBottom: "14px",
          },
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
      return createElement(
        "div",
        {
          "data-export-md-wrap": "",
          style: { margin: "0", display: "flow-root" },
        },
        createElement(StaticMarkdown, { md: section.md }),
      );
  }
}

function BaseContentRoot({
  sections,
  onMounted,
}: {
  sections: readonly AnnotationBaseSection[];
  onMounted: () => void;
}): ReactElement {
  return createElement(
    "div",
    {
      "data-annotation-base-content": "",
      ref: onMounted,
      style: {
        position: "relative",
        background: "#ffffff",
        boxSizing: "border-box",
        width: `${ANNOTATION_BASE_WIDTH_CSS}px`,
        paddingLeft: `${ANNOTATION_BASE_PAGE_PADDING_CSS}px`,
        paddingRight: `${ANNOTATION_BASE_PAGE_PADDING_CSS}px`,
      },
    },
    sections.map((section, i) =>
      createElement(
        "div",
        { key: `s${i}`, "data-export-block": section.kind },
        renderSectionElement(section),
      ),
    ),
  );
}

function renderBaseContent(
  root: Root,
  sections: readonly AnnotationBaseSection[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      root.render(
        createElement(BaseContentRoot, {
          sections,
          onMounted: () => resolve(),
        }),
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 拆 markdown 包装层：逐顶层元素成块（与 T6R.19 同手法；测量口径一致） */
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

/** ::image 渲染层的 src 归一化预解码（mediaSrcs 契约清单 → 测量前真图） */
function mediaUrlsOf(preview: AnnotationBasePreviewData): string[] {
  return preview.mediaSrcs.map(normalizeImageSrc);
}

/** 组装底图页节点：全部块进单页容器（页首块 margin-top 归零，同 T6R.19 口径） */
function buildBasePageNode(
  host: HTMLElement,
  contentHeightCss: number,
  blockNodes: readonly HTMLElement[],
): HTMLElement {
  const page = document.createElement("div");
  page.setAttribute("data-annotation-base-page", "0");
  Object.assign(page.style, {
    width: `${ANNOTATION_BASE_WIDTH_CSS}px`,
    boxSizing: "border-box",
    padding: `${ANNOTATION_BASE_PAGE_PADDING_CSS}px`,
    height: `${contentHeightCss + 2 * ANNOTATION_BASE_PAGE_PADDING_CSS}px`,
    background: "#ffffff",
    display: "flow-root",
    fontFamily: ANNOTATION_BASE_FONT_STACK,
    fontSize: "16px",
    lineHeight: "1.75",
    color: "#0f172a",
  });
  for (const node of blockNodes) page.appendChild(node);
  const first = page.firstElementChild as HTMLElement | null;
  if (first !== null) first.style.marginTop = "0";
  host.appendChild(page);
  return page;
}

// ---------- 缺省依赖实现（真实浏览器链路） ----------

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

async function rasterizePageWithHtmlToImage(
  node: HTMLElement,
  cssHeight: number,
  fontCss: string,
): Promise<Blob> {
  const blob = await toBlob(node, {
    width: ANNOTATION_BASE_WIDTH_CSS,
    height: Math.ceil(cssHeight),
    pixelRatio: ANNOTATION_BASE_PIXEL_RATIO,
    backgroundColor: "#ffffff",
    fontEmbedCSS: fontCss,
  });
  if (blob === null || blob.size === 0) {
    throw new Error("底图栅格化未产出 PNG 数据");
  }
  return blob;
}

async function pngBlobHasMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return PNG_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * 采样判断整页空白（与 T6R.19 samplePngBlank 同口径：缩 64×64 单次读回；
 * 校验链路故障不误杀）。rgbaSampleAllBlank 复用 T6R.19 导出（同一实现）。
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
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 主流程 ----------

/**
 * 生成标注底图（适配器主流程）：
 * 模型守卫 → 字体嵌入 → ::image 预解码 → 离屏渲染 → 测量 → **单页高计划**
 * （超高 → too-tall 显式禁用原因）→ 栅格化 + 产物校验（魔数/空白）→ 返回 Blob。
 * 失败零副作用（离屏宿主必然清理）；调用方（两阶段流）据此上传或禁用入口。
 */
export async function renderAnnotationBaseImage(
  preview: AnnotationBasePreviewData,
  deps: AnnotationBaseRenderDeps = {},
): Promise<AnnotationBaseRenderResult> {
  let sections: readonly AnnotationBaseSection[];
  try {
    sections = buildAnnotationBaseSections(preview);
  } catch (err) {
    return errOf("forbidden", err);
  }
  if (typeof document === "undefined") {
    return errOf("rasterize", "底图生成需要浏览器环境（当前环境无 DOM）");
  }

  const host = document.createElement("div");
  host.setAttribute("data-annotation-base-host", "");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    width: `${ANNOTATION_BASE_WIDTH_CSS}px`,
    background: "#ffffff",
    zIndex: "-1",
  });
  document.body.appendChild(host);
  let root: Root | null = null;
  const loadImageFn =
    deps.loadImages !== undefined ? deps.loadImages : preloadImages;
  const stepTimeoutMs = deps.stepTimeoutMs ?? ANNOTATION_BASE_STEP_TIMEOUT_MS;
  try {
    // ① 本地字体嵌入（失败/挂起超时同分类显式放弃）
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
      return errOf("font", `本地字体嵌入失败（${msgOf(err)}）——已放弃生成底图`);
    }
    try {
      await withTimeout(
        Promise.resolve(document.fonts.ready),
        stepTimeoutMs,
        "document.fonts.ready 等待超时",
      );
    } catch {
      // 旧环境 fonts 集不可等待：字体嵌入失败已有独立分类，不阻断
    }

    // ② ::image 图片预解码（测量高度需要真实尺寸）
    const imageUrls = mediaUrlsOf(preview);
    if (imageUrls.length > 0) {
      try {
        await withTimeout(
          loadImageFn(imageUrls),
          stepTimeoutMs,
          `图片解码超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
        );
      } catch (err) {
        return errOf(
          "media",
          `题面配图加载失败（${msgOf(err)}）——已放弃生成底图，本题暂不能标注`,
        );
      }
    }

    // ③ 离屏渲染（React 挂载到固定宽容器；commit 后拆 markdown 块）
    const reactHost = document.createElement("div");
    host.appendChild(reactHost);
    root = createRoot(reactHost);
    await renderBaseContent(root, sections);
    const content = reactHost.querySelector<HTMLElement>(
      "[data-annotation-base-content]",
    );
    if (content === null) {
      return errOf("rasterize", "离屏内容构建失败（未找到内容根节点）");
    }
    unwrapMarkdownWrappers(content);
    const blockNodes = [...content.children] as HTMLElement[];

    // ④ 测量 + 单页高计划（超高 → 显式禁用，不生成不截断）
    const heights =
      deps.measureBlockHeights !== undefined
        ? deps.measureBlockHeights(blockNodes.length)
        : measureBlockExtents(content, blockNodes);
    const plan = planAnnotationBaseHeight(
      blockNodes.map((_, i) => ({ id: `b${i}`, heightPx: heights[i] ?? 0 })),
    );
    if (!plan.ok) {
      return errOf("too-tall", plan.reason);
    }

    let pixel: { width: number; height: number };
    try {
      pixel = annotationBaseCanvasPixelSize(plan.contentHeightCss);
    } catch (err) {
      return errOf("canvas-limit", msgOf(err));
    }

    // ⑤ 组装单页 → 栅格化 + 产物校验
    const cssHeight =
      plan.contentHeightCss + 2 * ANNOTATION_BASE_PAGE_PADDING_CSS;
    const pageNode = buildBasePageNode(host, plan.contentHeightCss, blockNodes);
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
              cssWidth: ANNOTATION_BASE_WIDTH_CSS,
              cssHeight,
              pixelWidth: pixel.width,
              pixelHeight: pixel.height,
            })
          : rasterizePageWithHtmlToImage(pageNode, cssHeight, fontCss),
        stepTimeoutMs,
        `栅格化超时（${Math.round(stepTimeoutMs / 1000)} 秒）`,
      );
    } catch (err) {
      return errOf("rasterize", `底图栅格化失败（${msgOf(err)}）`);
    }
    if (!(await pngBlobHasMagic(blob))) {
      return errOf("encode", "底图 PNG 编码失败（空输出或非 PNG）——不采用残缺文件");
    }
    const blank =
      deps.samplePngBlank !== undefined
        ? await deps.samplePngBlank(blob)
        : await samplePngBlank(blob);
    if (blank) {
      return errOf("encode", "底图栅格化为空白图片（字体或渲染失败）——不采用空白图");
    }
    return {
      ok: true,
      blob,
      pixelWidth: pixel.width,
      pixelHeight: pixel.height,
    };
  } catch (err) {
    return errOf("rasterize", `底图生成失败（${msgOf(err)}）`);
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
