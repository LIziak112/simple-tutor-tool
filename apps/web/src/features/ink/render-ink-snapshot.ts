import type { InkDoc } from "@tutor/contract";
import {
  type NotePagePlan,
  renderNotePage,
} from "@/features/notes/render-note";
import { paddedStrokeBoxesOf, unionOfBoxes } from "./engine/bounds";

/** 正式作答图片只消费固定文档，与活画布及未收笔采样隔离。 */
export function planInkSnapshot(
  doc: Extract<InkDoc, { engine: "atrament" }>,
): NotePagePlan {
  const bounds = unionOfBoxes(paddedStrokeBoxesOf(doc.data.strokes));
  const y = Math.min(0, Math.floor(bounds?.minY ?? 0));
  const height = Math.max(320, Math.ceil((bounds?.maxY ?? 0) - y + 24));
  if (!Number.isFinite(height) || height > 16384)
    throw new Error("手写纸面过长，请精简后重试保存");
  const scale = Math.min(1, 4096 / height);
  return {
    pageIndex: 0,
    crop: { x: 0, y, width: 1000, height },
    pixelWidth: Math.floor(1000 * scale),
    pixelHeight: Math.ceil(height * scale),
  };
}

export async function renderInkSnapshot(doc: InkDoc): Promise<Blob> {
  if (doc.engine === "excalidraw") {
    const { renderExcalidrawSnapshot } = await import(
      "./engine/excalidraw-adapter"
    );
    return renderExcalidrawSnapshot(doc);
  }
  const page = planInkSnapshot(doc);
  const rendered = await renderNotePage(
    {
      version: 1,
      ink: doc.data,
      background: "white",
      paperHeightLogical: page.crop.height,
    },
    page,
  );
  return rendered.blob;
}
