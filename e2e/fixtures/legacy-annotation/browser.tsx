import { createRoot } from "react-dom/client";
import { renderAnnotationBaseImage } from "@/features/annotation/base-image";
import type {
  AnnotationBasePreviewData,
  AttemptQuestionPublic,
} from "../../../packages/contract/src/index";
import { QuestionSurface } from "./QuestionSurface";
import {
  awaitQuestionSurfaceReady,
  measureQuestionSurface,
  renderQuestionBaseImage,
} from "./question-base-image";

/** 真 DOM、旧 viewport sm 断点、原始 430px 逻辑题列，未经过现行恢复器。 */
export async function captureLegacyQuestion(
  question: AttemptQuestionPublic,
  hashOnly: boolean,
) {
  const host = document.createElement("div");
  host.dataset.slot = "legacy-fixture-host";
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "430px",
    background: "white",
    color: "#0f172a",
    zIndex: "10000",
  });
  const historicalCss = document.createElement("style");
  historicalCss.textContent =
    '@media (min-width: 640px) { [class~="sm:w-20"] { width: 5rem; } }';
  document.head.append(historicalCss);
  document.body.append(host);
  const root = createRoot(host);
  try {
    await new Promise<void>((resolve) =>
      root.render(
        <div
          ref={(node) => {
            if (node) resolve();
          }}
        >
          <QuestionSurface question={question} mode="export" />
        </div>,
      ),
    );
    const surface = host.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!surface) throw new Error("旧题面未挂载");
    await awaitQuestionSurfaceReady(surface);
    const sourceGeometry = measureQuestionSurface(surface);
    const result = await renderQuestionBaseImage(question, surface);
    // 无 compatibility 的真实历史版本：只删可选证据，不改原始几何、签名或 PNG。
    if (hashOnly) delete result.layout.compatibility;
    const image = await createImageBitmap(result.blob);
    if (
      image.width !== result.pixelWidth ||
      image.height !== result.pixelHeight
    )
      throw new Error("旧 PNG 真实尺寸不符");
    image.close();
    return {
      layout: result.layout,
      sourceGeometry,
      png: Array.from(new Uint8Array(await result.blob.arrayBuffer())),
      pixelWidth: result.pixelWidth,
      pixelHeight: result.pixelHeight,
    };
  } finally {
    root.unmount();
    host.remove();
    historicalCss.remove();
  }
}

/** v1 仍走原 720 CSS 固定宽、页眉/时间/留白的静态底图管线。 */
export async function captureLegacyV1(preview: AnnotationBasePreviewData) {
  const result = await renderAnnotationBaseImage(preview);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return {
    png: Array.from(new Uint8Array(await result.blob.arrayBuffer())),
    pixelWidth: result.pixelWidth,
    pixelHeight: result.pixelHeight,
  };
}
