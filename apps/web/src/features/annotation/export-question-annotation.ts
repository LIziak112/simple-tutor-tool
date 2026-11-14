import type {
  AnnotationViewData,
  AttemptQuestionPublic,
} from "@tutor/contract";
import {
  draftStore,
  getDraftPersistenceState,
  getDraftSessionEpoch,
} from "@/features/persistence/draft-store";
import { serviceLease } from "@/features/runtime/service-leases";

import {
  type AnnotationScope,
  type AnnotationSessionRef,
  getAnnotationRecord,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import { resolveQuestionSurface } from "./question-surface-resolver";
import { renderCurrentQuestionImage } from "./render-current-question";

/** 当前题面快照只读：原生题面、本人答案和选定的原域笔迹；不准备或写回底图。 */
export async function exportQuestionAnnotationImage(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement | null,
  options: { includeAnnotation?: boolean } = {},
): Promise<Blob> {
  const { fetchAnnotationViewApi } = serviceLease(session);

  const epoch = getDraftSessionEpoch();
  const isCurrent = () =>
    currentAnnotationSession() === session && getDraftSessionEpoch() === epoch;
  const guard = () => {
    if (!isCurrent()) throw new Error("会话已切换，请重新导出");
  };
  guard();
  if (scope.questionId !== question.id)
    throw new Error("当前题目身份不符，原稿已保留");
  const draft = await draftStore.loadDraft(scope.attemptId, {
    strictRead: true,
  });
  guard();
  if (getDraftPersistenceState(scope.attemptId) !== "saved")
    throw new Error("本机作答未保存，请重试保存后导出");
  if (draft?.answerConflicts?.[scope.questionId] !== undefined)
    throw new Error("本题答案存在待裁决冲突，请先选择保留版本");
  const answer = draft?.answers[scope.questionId];
  if (options.includeAnnotation === false) {
    const blob = await renderCurrentQuestionImage(question, {
      answer,
      layout: null,
      doc: null,
      reference: surface,
      shouldAbort: () => !isCurrent(),
    });
    guard();
    return blob;
  }
  const record = await getAnnotationRecord(session, scope, {
    strictRead: true,
  });
  guard();
  if (record && record.local !== "saved")
    throw new Error("本机标画未保存，请重试保存后导出");
  if (record?.conflict || record?.denied)
    throw new Error("标画存在同步冲突或被拒，请处理后导出");
  let view: AnnotationViewData | null = null;
  if (!record) {
    view = await fetchAnnotationViewApi(
      scope.attemptId,
      scope.questionId,
      scope.phase,
    );
    guard();
  }
  if (record?.sealedAt != null || view?.annotation?.sealedAt != null)
    throw new Error("标画已随交卷固定，请到结果页导出");
  const resolved = resolveQuestionSurface(
    record ??
      (view && (view.annotation || view.base || view.doc)
        ? {
            localBase: null,
            base: view.base,
            doc: view.doc,
            sealedAt: view.annotation?.sealedAt ?? null,
            conflict: null,
            retained: null,
            pending: null,
          }
        : null),
    question.questionRevisionId,
  );
  if (resolved.status === "blocked")
    throw new Error(resolved.reason ?? "原稿无法核对，原记录已保留");
  const doc = resolved.source
    ? structuredClone(record?.doc ?? view?.doc ?? null)
    : null;
  const blob = await renderCurrentQuestionImage(question, {
    answer,
    layout: resolved.source?.layout ?? null,
    doc,
    reference: surface,
    shouldAbort: () => !isCurrent(),
  });
  guard();
  return blob;
}
