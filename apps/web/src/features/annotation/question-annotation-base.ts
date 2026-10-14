import type { AnnotationBaseRef, AttemptQuestionPublic } from "@tutor/contract";
import { withTimeout } from "@/features/notes/rasterize-utils";
import {
  ApiError,
  fetchAnnotationViewApi,
  studentAnnotationBasePngUrl,
} from "@/lib/api";
import { SerialTaskQueue } from "@/lib/serial-task-queue";
import {
  type AnnotationLocalRecord,
  type AnnotationScope,
  type AnnotationSessionRef,
  applyAnnotationView,
  getAnnotationRecord,
  settleAnnotationRecordPersistence,
  writeLocalAnnotationBase,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import { renderQuestionBaseImage } from "./question-base-image";

const rasterQueue = new SerialTaskQueue();
export type QuestionAnnotationBaseResult =
  | {
      kind: "surface";
      localBase: NonNullable<AnnotationLocalRecord["localBase"]>;
    }
  | { kind: "legacy"; base: AnnotationBaseRef }
  | { kind: "sealed" };

/** 只由当前题显式调用；全局最多一个栅格任务，缓存不等待网络。 */
export async function prepareQuestionAnnotationBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
): Promise<QuestionAnnotationBaseResult> {
  const guard = () => {
    if (currentAnnotationSession() !== session)
      throw new Error("标画会话已切换，请重新打开");
  };
  guard();
  if (scope.questionId !== question.id) throw new Error("标画题目标识不匹配");
  const cached = await getAnnotationRecord(session, scope);
  guard();
  if (cached?.localBase != null) {
    await settleAnnotationRecordPersistence(session, scope);
    guard();
    const saved = await getAnnotationRecord(session, scope);
    guard();
    if (saved?.local !== "saved" || !saved.localBase)
      throw new Error(saved?.localError ?? "本机底图未保存，请重试");
    return { kind: "surface", localBase: saved.localBase };
  }
  if (cached?.base != null && cached.base.layout === undefined)
    return { kind: "legacy", base: cached.base };
  let remoteDoc = cached?.pending?.doc ?? null;
  let base = cached?.base ?? null;
  try {
    const view = await withTimeout(
      fetchAnnotationViewApi(scope.attemptId, scope.questionId, scope.phase),
      15_000,
      "底图状态加载超时，改为本机保存",
    );
    guard();
    if (view.annotation?.sealedAt != null) return { kind: "sealed" };
    await applyAnnotationView(session, scope, view);
    guard();
    base = view.base;
    remoteDoc ??= view.doc;
  } catch (error) {
    guard();
    if (
      error instanceof ApiError &&
      (error.status < 500 || error.code === "EXPORT_ASSEMBLY_BROKEN")
    )
      throw error;
    // 网络失败允许从已经授权显示的公开题面建本机稿，重连时严格绑定。
  }
  if (base !== null && base.layout === undefined)
    return { kind: "legacy", base };
  if (base?.state === "ready" && base.layout !== undefined) {
    const response = await fetch(
      studentAnnotationBasePngUrl(scope.attemptId, base.baseId),
      { signal: AbortSignal.timeout(15_000) },
    );
    guard();
    if (!response.ok) throw new Error("原标画底图下载失败，请重试");
    const png = await response.blob();
    guard();
    const layout = base.layout;
    await writeLocalAnnotationBase(
      session,
      scope,
      { png, layout },
      remoteDoc ?? {
        version: 1,
        baseWidth: base.pixelWidth ?? 0,
        baseHeight: base.pixelHeight ?? 0,
        strokes: [],
      },
    );
  } else {
    const rendered = await rasterQueue.run(async () => {
      guard();
      return renderQuestionBaseImage(question, surface);
    });
    guard();
    if (
      base?.layout !== undefined &&
      JSON.stringify(base.layout) !== JSON.stringify(rendered.layout)
    )
      throw new Error("另一设备已绑定不同布局，不能替换；请查看原标画");
    await writeLocalAnnotationBase(
      session,
      scope,
      { png: rendered.blob, layout: rendered.layout },
      remoteDoc ?? {
        version: 1,
        baseWidth: rendered.pixelWidth,
        baseHeight: rendered.pixelHeight,
        strokes: [],
      },
    );
  }
  guard();
  const saved = await getAnnotationRecord(session, scope);
  guard();
  if (!saved?.localBase || saved.local !== "saved")
    throw new Error("本机底图未保存，请重试");
  return { kind: "surface", localBase: saved.localBase };
}
