import type { AttemptQuestionPublic } from "@tutor/contract";
import { fetchAnnotationViewApi } from "@/lib/api";
import {
  exportAnnotationComposite,
  exportAnnotationCompositeSource,
} from "./annotation-composite";
import {
  type AnnotationScope,
  type AnnotationSessionRef,
  getAnnotationRecord,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";

/** 同份公开底图与矢量快照；不克隆带个人输入/提示的整张题卡。 */
export async function exportQuestionAnnotationImage(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
): Promise<Blob> {
  const guard = () => {
    if (currentAnnotationSession() !== session)
      throw new Error("会话已切换，请重新导出");
  };
  guard();
  const prepared = await prepareQuestionAnnotationBase(
    session,
    scope,
    question,
    surface,
  );
  guard();
  if (prepared.kind === "sealed")
    throw new Error("标画已随交卷固定，请到结果页导出");
  const record = await getAnnotationRecord(session, scope);
  guard();
  if (prepared.kind === "legacy") {
    const view = await fetchAnnotationViewApi(
      scope.attemptId,
      scope.questionId,
      scope.phase,
    );
    guard();
    const base = view.base ?? prepared.base;
    const doc = record?.doc ??
      view.doc ?? {
        version: 1 as const,
        baseWidth: base.pixelWidth ?? 0,
        baseHeight: base.pixelHeight ?? 0,
        strokes: [],
      };
    const result = await exportAnnotationComposite(base, doc);
    guard();
    if (!result.ok) throw new Error(result.error.message);
    return result.blob;
  }
  if (!record?.localBase || record.local !== "saved")
    throw new Error("本机标画未保存，请重试保存后导出");
  const { png, layout } = record.localBase;
  const url = URL.createObjectURL(png);
  try {
    const result = await exportAnnotationCompositeSource(
      {
        downloadUrl: url,
        pixelWidth: Math.ceil(layout.cssWidth * layout.pixelRatio),
        pixelHeight: Math.ceil(layout.cssHeight * layout.pixelRatio),
      },
      record.doc,
    );
    guard();
    if (!result.ok) throw new Error(result.error.message);
    return result.blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
