import type { AttemptQuestionPublic } from "@tutor/contract";
import { fetchAnnotationViewApi } from "@/lib/api";
import { exportAnnotationCompositeSource } from "./annotation-composite";
import {
  type AnnotationScope,
  type AnnotationSessionRef,
  getAnnotationRecord,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { renderQuestionBaseImage } from "./question-base-image";

/** 同份公开底图与矢量快照；不克隆带个人输入/提示的整张题卡。
 * surface 允许 null（B05 AI 材料采集：材料收起/画布释放时仍从已保存底图
 * 合成）；只有需要新渲染题面的路径要求活题面，此时给明确可重试错误。 */
export async function exportQuestionAnnotationImage(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement | null,
): Promise<Blob> {
  const guard = () => {
    if (currentAnnotationSession() !== session)
      throw new Error("会话已切换，请重新导出");
  };
  guard();
  const before = await getAnnotationRecord(session, scope);
  guard();
  if (!before?.localBase && !before?.base && !before?.doc?.strokes.length) {
    const view = await fetchAnnotationViewApi(
      scope.attemptId,
      scope.questionId,
      scope.phase,
    );
    guard();
    if (view.annotation?.sealedAt != null)
      throw new Error("标画已随交卷固定，请到结果页导出");
    if (!view.base && !view.doc?.strokes.length) {
      if (!surface) throw new Error("题面尚未就绪，请重试");
      const rendered = await renderQuestionBaseImage(question, surface);
      guard();
      return rendered.blob;
    }
  }
  const prepared = await prepareQuestionAnnotationBase(
    session,
    scope,
    question,
    surface,
  );
  guard();
  if (prepared.kind === "sealed")
    throw new Error("标画已随交卷固定，请到结果页导出");
  if (prepared.kind === "legacy")
    throw new Error("此题标画为旧版，仅可查看原圈画，暂不支持导出合成");
  const record = await getAnnotationRecord(session, scope);
  guard();
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
        cssWidth: layout.cssWidth,
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
