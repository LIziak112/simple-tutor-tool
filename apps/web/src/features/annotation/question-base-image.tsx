import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  ANNOTATION_MAX_PIXEL_DIM,
  ANNOTATION_SURFACE_PIXEL_RATIO,
  ANNOTATION_SURFACE_RENDER_VERSION,
  type AnnotationSurfaceCompatibility,
  type AnnotationSurfaceLayout,
  type AttemptQuestionPublic,
  annotationSurfaceLayoutSchema,
} from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { toBlob } from "html-to-image";
import { createRoot } from "react-dom/client";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import {
  collectFontEmbedCss,
  pngBlobHasMagic,
  samplePngBlank,
  TEACHER_SECTION_MARKERS,
  withTimeout,
} from "@/features/notes/rasterize-utils";
import { contentHash64, stableContentHash64 } from "@/lib/content-hash";
import { measureStage } from "@/lib/performance-stages";
import {
  compatibleSurfaceEvidence,
  legacySurfaceFontCandidates,
  normalizeSurfaceFont,
} from "./annotation-layout-compatibility";

const STEP_TIMEOUT_MS = 15_000;
const BLOCK_SELECTOR =
  "p, label, input:not(.sr-only), .katex, figure, img, table, th, td, li, svg, canvas";
const FONT_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
] as const;

/** 几何不含表单值、选中态和焦点；适用于正常题面与脱敏副本。 */
export function measureQuestionSurface(surface: HTMLElement) {
  const root = surface.getBoundingClientRect();
  const declaredScale = Number(
    surface.closest<HTMLElement>("[data-annotation-scale]")?.dataset
      .annotationScale ?? 1,
  );
  const scale =
    Number.isFinite(declaredScale) && declaredScale > 0 ? declaredScale : 1;
  const rounded = (value: number) => Math.round((value / scale) * 64) / 64;
  const nodes = [
    surface,
    ...[...surface.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
      (node) => !node.closest('[data-slot="question-annotation-overlay"]'),
    ),
  ];
  const textRects: AnnotationSurfaceCompatibility["textRects"] = [];
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (
      !node.textContent?.trim() ||
      node.parentElement?.closest(
        '.sr-only, .katex-mathml, input, textarea, select, [data-slot="question-annotation-overlay"]',
      )
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    // jsdom 无文本行测量；真实浏览器按每个文本片段的行框核对换行。
    if (typeof range.getClientRects !== "function") continue;
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      textRects.push({
        x: rounded(rect.left - root.left),
        y: rounded(rect.top - root.top),
        width: rounded(rect.width),
        height: rounded(rect.height),
      });
    }
  }
  return {
    cssWidth: root.width / scale,
    cssHeight: root.height / scale,
    textRects,
    blocks: nodes.map((node) => {
      const rect = node === surface ? root : node.getBoundingClientRect();
      // LR-5：最近的 data-lr-node 祖先（含自身）的语义节点键；QuestionSurface
      // 根带 "root"，新底图每块都有键；裸 DOM（无键）时缺省省略
      const nodeKey =
        node.getAttribute("data-lr-node") ??
        node.closest("[data-lr-node]")?.getAttribute("data-lr-node") ??
        undefined;
      return {
        tag: node.tagName,
        ...(nodeKey !== undefined ? { node: nodeKey } : {}),
        x: rounded(rect.left - root.left),
        y: rounded(rect.top - root.top),
        width: rounded(rect.width),
        height: rounded(rect.height),
      };
    }),
    fonts: nodes.map((node) => {
      const style = getComputedStyle(node);
      return FONT_PROPERTIES.map((property) =>
        style.getPropertyValue(property),
      ) as [string, string, string, string, string];
    }),
  };
}

type SurfaceMeasure = ReturnType<typeof measureQuestionSurface>;
function sameGeometry(left: SurfaceMeasure, right: SurfaceMeasure): boolean {
  return (
    Math.abs(left.cssWidth - right.cssWidth) <= 1 &&
    Math.abs(left.cssHeight - right.cssHeight) <= 1 &&
    compatibleSurfaceEvidence(left, right)
  );
}

/** 提取公开题面内容指纹数据源（新旧题型统一完整口径） */
export function publicContentSignatureOf(question: AttemptQuestionPublic) {
  return {
    type: question.type,
    stemMd: question.stemMd,
    options: question.options ?? [],
    ...(question.matchingOptions
      ? { matchingOptions: question.matchingOptions }
      : {}),
    ...(question.matchingSlots
      ? { matchingSlots: question.matchingSlots }
      : {}),
    ...(question.orderingItems
      ? { orderingItems: question.orderingItems }
      : {}),
    ...(question.sortableCount !== undefined
      ? { sortableCount: question.sortableCount }
      : {}),
    ...(question.wordMin !== undefined ? { wordMin: question.wordMin } : {}),
    ...(question.wordMax !== undefined ? { wordMax: question.wordMax } : {}),
  };
}

/**
 * 几何签名的块投影（LR-5 回归根因修复）：剥掉 blocks[].node 再哈希——
 * node 是 PR2 新增的语义键，旧底图的 geometrySignature 是无 node 时代的块
 * 哈希；把 node 计入会让旧设备核验永远失配、旧稿无法续写。存档证据里的
 * blocks[].node 原样保留（锚点重投影要用），只影响签名输入。
 */
function geometryBlocksProjection(
  blocks: AnnotationSurfaceCompatibility["blocks"],
): unknown[] {
  return blocks.map(({ node: _node, ...rect }) => rect);
}

/** 只测量公开题面；与建底图共享签名算法，不栅格化、不取表单值。 */
export async function questionSurfaceMatchesLayout(
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  layout: AnnotationSurfaceLayout,
): Promise<boolean> {
  const measure = measureQuestionSurface(surface);
  if (
    question.questionRevisionId !== layout.questionRevisionId ||
    Math.abs(measure.cssWidth - layout.cssWidth) > 1 ||
    Math.abs(measure.cssHeight - layout.cssHeight) > 1
  )
    return false;
  const publicContent = publicContentSignatureOf(question);
  if (layout.compatibility) {
    return (
      stableContentHash64(publicContent) ===
        layout.compatibility.contentSignature &&
      compatibleSurfaceEvidence(layout.compatibility, measure)
    );
  }
  return (
    (await legacyCompatibility(
      {
        type: question.type,
        stemMd: question.stemMd,
        options: question.options ?? [],
      },
      measure,
      layout,
    )) !== null
  );
}

async function legacyCompatibility(
  publicContent: {
    type: AttemptQuestionPublic["type"];
    stemMd: string;
    options: string[];
  },
  measure: SurfaceMeasure,
  layout: AnnotationSurfaceLayout,
): Promise<AnnotationSurfaceCompatibility | null> {
  const matchesLegacyHash = async (value: unknown, saved: string) =>
    stableContentHash64(value) === saved ||
    (await contentHash64(value)) === saved;
  if (
    !(await matchesLegacyHash(publicContent, layout.contentSignature)) ||
    !(await matchesLegacyHash(
      geometryBlocksProjection(measure.blocks),
      layout.geometrySignature,
    ))
  )
    return null;
  for (const candidate of legacySurfaceFontCandidates(measure.fonts)) {
    if (await matchesLegacyHash(candidate, layout.fontSignature))
      return {
        version: 1,
        contentSignature: stableContentHash64(publicContent),
        blocks: measure.blocks,
        fonts: candidate,
        textRects: measure.textRects,
      };
  }
  return null;
}

/** 显式续写时为旧稿生成可核验的补充证据；原签名未命中绝不生成。 */
export async function verifiedLegacySurfaceCompatibility(
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  layout: AnnotationSurfaceLayout,
): Promise<AnnotationSurfaceCompatibility | null> {
  const measure = measureQuestionSurface(surface);
  if (
    layout.compatibility ||
    question.questionRevisionId !== layout.questionRevisionId ||
    Math.abs(measure.cssWidth - layout.cssWidth) > 1 ||
    Math.abs(measure.cssHeight - layout.cssHeight) > 1
  )
    return null;
  return legacyCompatibility(
    {
      type: question.type,
      stemMd: question.stemMd,
      options: question.options ?? [],
    },
    measure,
    layout,
  );
}

export function assertPublicQuestion(question: AttemptQuestionPublic): void {
  const texts: string[] = [question.stemMd, ...(question.options ?? [])];
  if (question.matchingOptions?.options) {
    for (const opt of question.matchingOptions.options) {
      texts.push(opt.text);
    }
  }
  if (question.orderingItems) {
    for (const item of question.orderingItems) {
      texts.push(item.text);
    }
  }
  for (const md of texts) {
    if (
      stemMdLeaksAnswers(md) ||
      TEACHER_SECTION_MARKERS.some((marker) => md.includes(marker))
    ) {
      throw new Error("题面包含答案标记或教师内容，拒绝生成底图");
    }
  }
}

function assertSize(surface: HTMLElement): void {
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0)
    throw new Error("题面尚未就绪，请稍后重试");
  if (
    Math.ceil(rect.width * ANNOTATION_SURFACE_PIXEL_RATIO) >
      ANNOTATION_MAX_PIXEL_DIM ||
    Math.ceil(rect.height * ANNOTATION_SURFACE_PIXEL_RATIO) >
      ANNOTATION_MAX_PIXEL_DIM
  ) {
    throw new Error("题面尺寸超限，不能生成完整底图；作答与草稿不受影响");
  }
  if (surface.scrollWidth > rect.width + 1)
    throw new Error("题面存在横向溢出，请先修正题面排版");
}

/** 返回已验证的最后一帧快照，避免调用方紧接着重复读取相同布局。 */
export async function awaitQuestionSurfaceReady(
  surface: HTMLElement,
  check: () => void = () => {},
): Promise<SurfaceMeasure> {
  const deadline = performance.now() + STEP_TIMEOUT_MS;
  if (document.fonts) await document.fonts.ready;
  const images = [...surface.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map((image) => image.decode()));
  check();
  let previous = "";
  let unchanged = 0;
  let snapshot: SurfaceMeasure | undefined;
  while (unchanged < 3) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    check();
    if (performance.now() > deadline) throw new Error("题面布局稳定等待超时");
    if (
      surface.querySelector(
        '.katex-error, .math-fallback, .math-render-error, [role="alert"]',
      )
    )
      throw new Error("题面公式或配图渲染失败，请修正后重试");
    if (surface.querySelector('[role="status"]')) {
      unchanged = 0;
      continue;
    }
    snapshot = measureQuestionSurface(surface);
    const current = JSON.stringify(snapshot);
    unchanged = previous === current ? unchanged + 1 : 0;
    previous = current;
  }
  if (!snapshot) throw new Error("题面尚未就绪，请重试");
  return snapshot;
}

/** U02准入管线：只从公开题目重建副本，绝不克隆带有本人答案的DOM。 */
export async function renderQuestionBaseImage(
  question: AttemptQuestionPublic,
  reference: HTMLElement,
  options: { signal?: AbortSignal; shouldAbort?: () => boolean } = {},
): Promise<{
  blob: Blob;
  layout: AnnotationSurfaceLayout;
  pixelWidth: number;
  pixelHeight: number;
}> {
  const check = () => {
    if (options.signal?.aborted || options.shouldAbort?.())
      throw new DOMException("底图预备已取消", "AbortError");
  };
  check();
  assertPublicQuestion(question);
  assertSize(reference);
  const before = await measureStage("annotation:reference-ready", () =>
    withTimeout(
      awaitQuestionSurfaceReady(reference, check),
      STEP_TIMEOUT_MS,
      "题面资源或布局未稳定，请稍后重试",
    ),
  );
  check();
  const host = document.createElement("div");
  host.dataset.slot = "question-base-host";
  host.setAttribute("aria-hidden", "true");
  const inherited = getComputedStyle(reference);
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${before.cssWidth}px`,
    backgroundColor: "#ffffff",
    color: "#0f172a",
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  for (const property of FONT_PROPERTIES)
    host.style.setProperty(property, inherited.getPropertyValue(property));
  // 只改变导出颜色；宽度、字体和内联空位尺寸与正常题面一致。
  host.style.setProperty("--card", "#ffffff");
  host.style.setProperty("--foreground", "#0f172a");
  host.style.setProperty("--border", "#cbd5e1");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await measureStage("annotation:public-copy", () =>
      withTimeout(
        new Promise<void>((resolve) =>
          root.render(
            <div
              ref={(node) => {
                if (node) resolve();
              }}
            >
              <QuestionSurface question={question} mode="export" />
            </div>,
          ),
        ),
        STEP_TIMEOUT_MS,
        "导出题面挂载超时",
      ),
    );
    const exported = host.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    check();
    if (!exported) throw new Error("导出题面未挂载");
    for (const image of exported.querySelectorAll<HTMLImageElement>("img"))
      image.loading = "eager";
    const exportedSnapshot = await measureStage("annotation:copy-ready", () =>
      withTimeout(
        awaitQuestionSurfaceReady(exported, check),
        STEP_TIMEOUT_MS,
        "导出题面资源未稳定，请重试",
      ),
    );
    check();
    assertSize(exported);
    if (
      !sameGeometry(before, exportedSnapshot) ||
      !sameGeometry(before, measureQuestionSurface(reference))
    )
      throw new Error("题面布局已变化或与底图不一致，请恢复原布局后重试");
    const publicContent = publicContentSignatureOf(question);
    const [contentSignature, geometrySignature, fontSignature] =
      await Promise.all([
        contentHash64(publicContent),
        contentHash64(geometryBlocksProjection(before.blocks)),
        contentHash64(before.fonts),
      ]);
    const layout = annotationSurfaceLayoutSchema.parse({
      renderVersion: ANNOTATION_SURFACE_RENDER_VERSION,
      questionRevisionId: question.questionRevisionId,
      cssWidth: before.cssWidth,
      cssHeight: before.cssHeight,
      pixelRatio: ANNOTATION_SURFACE_PIXEL_RATIO,
      styleVersion: 1,
      contentSignature,
      geometrySignature,
      fontSignature,
      compatibility: {
        version: 1,
        contentSignature: stableContentHash64(publicContent),
        blocks: before.blocks,
        fonts: before.fonts.map(normalizeSurfaceFont),
        textRects: before.textRects,
      },
    });
    const fontCss = await measureStage("annotation:font-css", () =>
      withTimeout(
        collectFontEmbedCss(exported),
        STEP_TIMEOUT_MS,
        "本地字体嵌入超时",
      ),
    );
    check();
    const pixelWidth = Math.ceil(before.cssWidth * layout.pixelRatio);
    const pixelHeight = Math.ceil(before.cssHeight * layout.pixelRatio);
    const blob = await measureStage("annotation:rasterize", () =>
      withTimeout(
        toBlob(exported, {
          width: before.cssWidth,
          height: before.cssHeight,
          canvasWidth: pixelWidth / layout.pixelRatio,
          canvasHeight: pixelHeight / layout.pixelRatio,
          pixelRatio: layout.pixelRatio,
          backgroundColor: "#ffffff",
          fontEmbedCSS: fontCss,
        }),
        STEP_TIMEOUT_MS,
        "题面栅格化超时",
      ),
    );
    check();
    const valid = await measureStage(
      "annotation:png-check",
      async () =>
        blob !== null &&
        (await pngBlobHasMagic(blob)) &&
        !(await samplePngBlank(blob)),
    );
    check();
    if (!blob || !valid)
      throw new Error("底图为空白或编码失败，不采用残缺图片");
    if (blob.size > ANNOTATION_BASE_PNG_MAX_BYTES)
      throw new Error("底图文件超限，请使用草稿纸");
    const header = new DataView(await blob.slice(0, 24).arrayBuffer());
    if (
      header.byteLength < 24 ||
      header.getUint32(16) !== pixelWidth ||
      header.getUint32(20) !== pixelHeight
    )
      throw new Error("底图实际像素尺寸不符，不采用错位图片");
    if (!sameGeometry(before, measureQuestionSurface(reference)))
      throw new Error("生成期间题面布局变化，请重试");
    return { blob, layout, pixelWidth, pixelHeight };
  } finally {
    root.unmount();
    host.remove();
  }
}
