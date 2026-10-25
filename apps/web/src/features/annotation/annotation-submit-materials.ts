import {
  getAnnotationRecord,
  listPendingAnnotations,
  settleAnnotationPersistence,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";

/** 不声明标画已封存；用户确认前按当前本机待传状态重新判断。 */
export async function snapshotAnnotationProblems(
  attemptId: string,
  questionIds: readonly string[],
): Promise<
  Array<{ questionId: string; reason: string; domain: "annotation" }>
> {
  const session = currentAnnotationSession();
  if (!session) return [];
  await settleAnnotationPersistence();
  const pending = await listPendingAnnotations(session, attemptId, {
    strictRead: true,
  });
  const allowed = new Set(questionIds);
  const problems: Array<{
    questionId: string;
    reason: string;
    domain: "annotation";
  }> = [];
  for (const scope of pending) {
    if (scope.phase !== "scratch" || !allowed.has(scope.questionId)) continue;
    const record = await getAnnotationRecord(session, scope);
    if (
      !record?.pending ||
      (record.doc.strokes.length === 0 && record.baseRevision === 0)
    )
      continue;
    problems.push({
      questionId: scope.questionId,
      domain: "annotation",
      reason:
        record.local === "failed"
          ? "标画本机保存失败，请保持页面打开并重试"
          : record.retained
            ? "标画已保留本机、不再自动同步：可重新尝试同步或采用云端版本后再交卷"
            : record.conflict
              ? `标画同步冲突：${record.conflict.reason}`
              : record.denied
                ? `标画同步被拒：${record.denied.reason}`
                : "标画尚未上传完整",
    });
  }
  if (currentAnnotationSession() !== session)
    throw new Error("学生会话已切换，请重新确认交卷");
  return problems;
}
