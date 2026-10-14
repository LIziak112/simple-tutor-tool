import { type InkDoc, inkDocSchema, type NoteDoc } from "@tutor/contract";
import {
  draftStore,
  getDraftPersistenceState,
} from "@/features/attempt/draft-store";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import { renderInkSnapshot } from "@/features/ink/render-ink-snapshot";
import { parseNoteDocOrThrow } from "@/features/notes/note-fixtures";
import {
  getNoteRecord,
  type NoteSessionRef,
} from "@/features/notes/note-store";
import { withTimeout } from "@/features/notes/rasterize-utils";
import { renderNoteImages } from "@/features/notes/render-note";
import {
  fetchAttemptInkApi,
  fetchStudentNoteDocumentApi,
  fetchStudentNoteHeadsApi,
} from "@/lib/api";

type OngoingPaper =
  | { kind: "草稿"; doc: NoteDoc }
  | { kind: "手写作答"; doc: InkDoc };
export interface OngoingExportPage {
  blob: Blob;
  label: string;
}

/** 不依赖纸面是否展开；读取失败不能被当作无稿。 */
export async function loadOngoingPaper(
  session: NoteSessionRef,
  attemptId: string,
  questionId: string,
  formal: boolean,
): Promise<OngoingPaper | null> {
  if (formal) {
    if (getDraftPersistenceState(attemptId) !== "saved")
      throw new Error("本机手写未保存，请重试保存后导出");
    const local = await draftStore.loadDraft(attemptId, { strictRead: true });
    const raw =
      local?.inks[questionId] ??
      (await fetchAttemptInkApi(attemptId, questionId));
    if (!raw) return null;
    const doc = inkDocSchema.parse(structuredClone(raw));
    if (doc.engine === "atrament" && doc.data.strokes.length === 0) return null;
    return { kind: "手写作答", doc };
  }
  const local = await getNoteRecord(
    session,
    { attemptId, questionId, phase: "scratch" },
    { strictRead: true },
  );
  if (local?.local !== undefined && local.local !== "saved")
    throw new Error("本机草稿未保存，请重试保存后导出");
  if (local?.conflict || local?.denied)
    throw new Error("草稿同步冲突或被拒，请处理后重新导出");
  // 本机有待传稿时保留当前版本；无待传稿重新检查云端，防止遗漏他端新稿。
  let raw: unknown = local?.doc;
  if (!local?.pending) {
    const [head] = await fetchStudentNoteHeadsApi(attemptId, [questionId]);
    if (!head) throw new Error("草稿状态读取失败，请重试");
    const versionId = head.note?.currentVersionId;
    raw = versionId ? await fetchStudentNoteDocumentApi(versionId) : raw;
  }
  if (!raw) return null;
  const doc = parseNoteDocOrThrow(structuredClone(raw));
  return doc.ink.strokes.length === 0 ? null : { kind: "草稿", doc };
}

/** 每页重复题面；正文切片在安全尺寸内按原比例绘制。 */
export function planOngoingImagePages(
  question: { width: number; height: number },
  paper: { width: number; height: number } | null,
) {
  for (const size of [question, ...(paper ? [paper] : [])]) {
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    )
      throw new Error("导出图片尺寸无效，请重试");
  }
  const questionScale = Math.min(
    1,
    1000 / question.width,
    2400 / question.height,
  );
  const questionHeight = Math.ceil(question.height * questionScale);
  const questionWidth = Math.ceil(question.width * questionScale);
  const paperScale = paper ? Math.min(1, 1000 / paper.width) : 1;
  const paperHeight = paper ? Math.ceil(paper.height * paperScale) : 0;
  const capacity = 4096 - questionHeight - 176;
  const count = Math.max(1, Math.ceil(paperHeight / capacity));
  return Array.from({ length: count }, (_, index) => {
    const sliceHeight = Math.min(
      capacity,
      Math.max(0, paperHeight - index * capacity),
    );
    return {
      width: 1048,
      height: questionHeight + sliceHeight + 176,
      questionWidth,
      questionHeight,
      paperWidth: paper ? Math.ceil(paper.width * paperScale) : 0,
      paperY: (index * capacity) / paperScale,
      paperSourceHeight: sliceHeight / paperScale,
      paperHeight: sliceHeight,
    };
  });
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await withTimeout(image.decode(), 15_000, "图片读取超时，请重试");
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 只合成本次固定快照；所有页均带题面，复制与下载共用产物。 */
export async function createOngoingQuestionImages(
  questionBlob: Blob,
  paper: OngoingPaper | null,
  title: string,
  guard: () => void,
  hasAnnotation = true,
): Promise<OngoingExportPage[]> {
  const question = await loadImage(questionBlob);
  guard();
  const paperBlobs = !paper
    ? []
    : paper.kind === "草稿"
      ? (await renderNoteImages(paper.doc, "analysis")).map((page) => page.blob)
      : [await renderInkSnapshot(paper.doc)];
  guard();
  const pages: OngoingExportPage[] = [];
  for (const blob of paperBlobs.length > 0 ? paperBlobs : [null]) {
    const image = blob ? await loadImage(blob) : null;
    guard();
    const plans = planOngoingImagePages(
      { width: question.naturalWidth, height: question.naturalHeight },
      image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    );
    for (const plan of plans) {
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("画布不可用，请重试");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#171717";
        ctx.font = "24px sans-serif";
        ctx.fillText(title, 24, 36, 1000);
        ctx.font = "18px sans-serif";
        ctx.fillText(hasAnnotation ? "题目与标画" : "题目", 24, 68);
        ctx.drawImage(
          question,
          24 + (1000 - plan.questionWidth) / 2,
          84,
          plan.questionWidth,
          plan.questionHeight,
        );
        if (image && paper) {
          ctx.fillText(
            `${paper.kind} · 第 ${pages.length + 1} 页`,
            24,
            plan.questionHeight + 120,
          );
          ctx.drawImage(
            image,
            0,
            plan.paperY,
            image.naturalWidth,
            plan.paperSourceHeight,
            24 + (1000 - plan.paperWidth) / 2,
            plan.questionHeight + 136,
            plan.paperWidth,
            plan.paperHeight,
          );
        }
        guard();
        const png = await canvasToPngBlob(canvas);
        guard();
        pages.push({
          blob: png,
          label: `${hasAnnotation ? "题面与标画" : "题面"}${paper ? `、${paper.kind}` : ""}`,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }
  return pages;
}
