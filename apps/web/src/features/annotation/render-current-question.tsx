import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  ANNOTATION_MAX_PIXEL_DIM,
  ANNOTATION_SURFACE_PIXEL_RATIO,
  type AnnotationDoc,
  type AnnotationSurfaceLayout,
  type AttemptQuestionPublic,
  annotationDocSchema,
  annotationSurfaceLayoutSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { toBlob } from "html-to-image";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { formatStudentAnswer } from "@/features/answering/answer-format";
import { QuestionSurface } from "@/features/answering/QuestionSurface";
import { QuestionRenderContext } from "@/features/answering/question-render-context";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import {
  collectFontEmbedCss,
  pngBlobHasMagic,
  samplePngBlank,
  withTimeout,
} from "@/features/notes/rasterize-utils";
import { replayAnnotationStroke } from "./annotation-surface";
import {
  assertPublicQuestion,
  awaitQuestionSurfaceReady,
  measureQuestionSurface,
  questionSurfaceMatchesLayout,
  resolveLegacyQuestionProfile,
} from "./question-base-image";

interface CurrentQuestionImageOptions {
  layout?: AnnotationSurfaceLayout | null;
  doc?: AnnotationDoc | null;
  answer?: StudentAnswer | undefined;
  reference?: HTMLElement | null;
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
}

/** 当前材料快照不写任何底图或正文；本人作答附在原坐标题面之后，避免长值被空位裁掉。 */
export async function renderCurrentQuestionImage(
  question: AttemptQuestionPublic,
  options: CurrentQuestionImageOptions = {},
): Promise<Blob> {
  const check = () => {
    if (options.signal?.aborted || options.shouldAbort?.())
      throw new DOMException("当前题面导出已取消", "AbortError");
  };
  check();
  assertPublicQuestion(question);
  const layout = options.layout
    ? annotationSurfaceLayoutSchema.parse(options.layout)
    : null;
  if (layout && layout.questionRevisionId !== question.questionRevisionId)
    throw new Error("原稿与当前题目版本不符，不能导出当前题面");
  const doc = options.doc ? annotationDocSchema.parse(options.doc) : null;
  if (
    doc &&
    (!layout ||
      doc.baseWidth !== Math.ceil(layout.cssWidth * layout.pixelRatio) ||
      doc.baseHeight !== Math.ceil(layout.cssHeight * layout.pixelRatio))
  )
    throw new Error("原稿与笔迹坐标不符，原记录已保留");
  const answer = options.answer ? structuredClone(options.answer) : undefined;
  const reference = options.reference ?? null;
  const referenceWidth = reference
    ? measureQuestionSurface(reference).cssWidth
    : 0;
  const cssWidth =
    layout?.cssWidth ??
    (Number.isFinite(referenceWidth) && referenceWidth > 0
      ? referenceWidth
      : 720);
  if (!Number.isFinite(cssWidth) || cssWidth <= 0)
    throw new Error("题面尺寸尚未就绪，请重试");
  const host = document.createElement("div");
  host.dataset.slot = "current-question-export-host";
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${cssWidth}px`,
    backgroundColor: "#ffffff",
    color: "#0f172a",
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  const inherited = getComputedStyle(reference ?? document.body);
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
  ])
    host.style.setProperty(property, inherited.getPropertyValue(property));
  host.style.setProperty("--card", "#ffffff");
  host.style.setProperty("--foreground", "#0f172a");
  host.style.setProperty("--border", "#cbd5e1");
  const content = document.createElement("div");
  host.appendChild(content);
  document.body.appendChild(host);
  const root = createRoot(content);
  const render = (direction?: "horizontal" | "vertical") => {
    flushSync(() =>
      root.render(
        <QuestionRenderContext
          value={{
            renderVersion: layout?.renderVersion ?? 4,
            logicalWidth: cssWidth,
            ...(direction ? { legacyDirection: direction } : {}),
          }}
        >
          <div style={{ minHeight: layout?.cssHeight }}>
            <QuestionSurface question={question} answer={answer} readOnly />
          </div>
          {answer && (
            <section className="mt-6 border-t border-border pt-4 text-base leading-[1.75]">
              <p className="mb-2 font-semibold">本人作答</p>
              {/* 本人输入按原文完整展示，不能被其 Markdown 折叠语法再次隐藏。 */}
              <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {formatStudentAnswer(answer)}
              </div>
            </section>
          )}
        </QuestionRenderContext>,
      ),
    );
  };
  try {
    render();
    let surface = host.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!surface) throw new Error("导出题面未挂载");
    if (layout && layout.renderVersion !== 4) {
      const direction = await resolveLegacyQuestionProfile(
        question,
        surface,
        layout,
        options.signal,
      );
      check();
      if (!direction)
        throw new Error("旧稿真实题面无法核对，原记录已保留；可导出历史证据");
      render(direction);
      surface = host.querySelector<HTMLElement>(
        '[data-slot="question-surface"]',
      );
      if (!surface) throw new Error("导出题面未挂载");
    }
    await awaitQuestionSurfaceReady(content, check, options.signal);
    check();
    if (
      layout &&
      !(await questionSurfaceMatchesLayout(question, surface, layout))
    )
      throw new Error("当前题面与原基准偏差超过 10px 或区域不符，原记录已保留");
    const cssHeight = content.getBoundingClientRect().height;
    const pixelWidth = Math.ceil(cssWidth * ANNOTATION_SURFACE_PIXEL_RATIO);
    const pixelHeight = Math.ceil(cssHeight * ANNOTATION_SURFACE_PIXEL_RATIO);
    if (
      !Number.isFinite(cssHeight) ||
      cssHeight <= 0 ||
      pixelWidth > ANNOTATION_MAX_PIXEL_DIM ||
      pixelHeight > ANNOTATION_MAX_PIXEL_DIM
    )
      throw new Error("当前题面材料尺寸超限，无法生成完整图片；原稿已保留");
    const fontCss = await withTimeout(
      collectFontEmbedCss(content),
      15_000,
      "本地字体嵌入超时",
    );
    check();
    const png = await withTimeout(
      toBlob(content, {
        width: cssWidth,
        height: cssHeight,
        canvasWidth: pixelWidth / ANNOTATION_SURFACE_PIXEL_RATIO,
        canvasHeight: pixelHeight / ANNOTATION_SURFACE_PIXEL_RATIO,
        pixelRatio: ANNOTATION_SURFACE_PIXEL_RATIO,
        backgroundColor: "#ffffff",
        fontEmbedCSS: fontCss,
      }),
      15_000,
      "当前题面栅格化超时",
    );
    check();
    if (!png || !(await pngBlobHasMagic(png)) || (await samplePngBlank(png)))
      throw new Error("当前题面为空白或编码失败，不采用残缺图片");
    if (png.size > ANNOTATION_BASE_PNG_MAX_BYTES)
      throw new Error("当前题面图片超限，原稿已保留");
    const header = new DataView(await png.slice(0, 24).arrayBuffer());
    if (
      header.byteLength < 24 ||
      header.getUint32(16) !== pixelWidth ||
      header.getUint32(20) !== pixelHeight
    )
      throw new Error("当前题面实际像素尺寸不符，不采用错位图片");
    if (
      layout &&
      !(await questionSurfaceMatchesLayout(question, surface, layout))
    )
      throw new Error("导出期间题面发生变化，原稿已保留，请重试");
    check();
    if (!doc?.strokes.length) return png;
    const image = new Image();
    const url = URL.createObjectURL(png);
    let atrament: ReturnType<typeof createProgrammaticAtrament> | null = null;
    try {
      image.src = url;
      await withTimeout(image.decode(), 15_000, "当前题面图片解码超时");
      check();
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      host.appendChild(canvas);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建导出画布");
      atrament = createProgrammaticAtrament(canvas);
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
      // 附加的本人作答只扩展导出画布；旧笔迹始终在原坐标域按原宽度重放。
      for (const stroke of doc.strokes)
        replayAnnotationStroke(atrament, cssWidth / doc.baseWidth, stroke);
      const result = await canvasToPngBlob(canvas);
      check();
      if (!result.size || result.size > ANNOTATION_BASE_PNG_MAX_BYTES)
        throw new Error("当前材料编码为空或超限，原稿已保留");
      return result;
    } finally {
      atrament?.destroy();
      URL.revokeObjectURL(url);
    }
  } finally {
    root.unmount();
    host.remove();
  }
}
