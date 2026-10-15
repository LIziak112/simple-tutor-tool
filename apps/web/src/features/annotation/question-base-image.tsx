import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  ANNOTATION_MAX_PIXEL_DIM,
  ANNOTATION_SURFACE_PIXEL_RATIO,
  ANNOTATION_SURFACE_RENDER_VERSION,
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
import { contentHash64 } from "@/lib/content-hash";
import { measureStage } from "@/lib/performance-stages";

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
  const rounded = (value: number) => Math.round(value * 64) / 64;
  const nodes = [
    surface,
    ...[...surface.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
      (node) => !node.closest('[data-slot="question-annotation-overlay"]'),
    ),
  ];
  return {
    cssWidth: root.width,
    cssHeight: root.height,
    blocks: nodes.map((node) => {
      const rect = node === surface ? root : node.getBoundingClientRect();
      return {
        tag: node.tagName,
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
      );
    }),
  };
}

type SurfaceMeasure = ReturnType<typeof measureQuestionSurface>;
function sameGeometry(left: SurfaceMeasure, right: SurfaceMeasure): boolean {
  return (
    Math.abs(left.cssWidth - right.cssWidth) <= 1 &&
    Math.abs(left.cssHeight - right.cssHeight) <= 1 &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => {
      const other = right.blocks[index];
      return (
        other !== undefined &&
        block.tag === other.tag &&
        (["x", "y", "width", "height"] as const).every(
          (key) => Math.abs(block[key] - other[key]) <= 1,
        )
      );
    }) &&
    JSON.stringify(left.fonts) === JSON.stringify(right.fonts)
  );
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
  const [content, geometry, fonts] = await Promise.all([
    contentHash64({
      type: question.type,
      stemMd: question.stemMd,
      options: question.options ?? [],
    }),
    contentHash64(measure.blocks),
    contentHash64(measure.fonts),
  ]);
  return (
    content === layout.contentSignature &&
    geometry === layout.geometrySignature &&
    fonts === layout.fontSignature
  );
}

function assertPublicQuestion(question: AttemptQuestionPublic): void {
  for (const md of [question.stemMd, ...(question.options ?? [])]) {
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
    const [contentSignature, geometrySignature, fontSignature] =
      await Promise.all([
        contentHash64({
          type: question.type,
          stemMd: question.stemMd,
          options: question.options ?? [],
        }),
        contentHash64(before.blocks),
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
