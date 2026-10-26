import type { AttemptQuestionPublic } from "@tutor/contract";
import { withTimeout } from "@/features/notes/rasterize-utils";
import { ApiError, postAnnotationBaseApi } from "@/lib/api";
import {
  type AnnotationLocalRecord,
  type AnnotationScope,
  type AnnotationSessionRef,
  applyAnnotationBaseCompatibility,
  getAnnotationRecord,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import { verifiedLegacySurfaceCompatibility } from "./question-base-image";

/** 仅显式原位编辑调用；查看、导出和封存回看不会补写云端元数据。 */
export async function prepareQuestionAnnotationContinuation(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  localBase: NonNullable<AnnotationLocalRecord["localBase"]>,
  signal?: AbortSignal,
): Promise<NonNullable<AnnotationLocalRecord["localBase"]>> {
  const guard = () => {
    if (signal?.aborted) throw new DOMException("续写已取消", "AbortError");
    if (currentAnnotationSession() !== session)
      throw new Error("圈画会话已切换，请重新打开");
  };
  guard();
  if (localBase.layout.compatibility) return localBase;
  const record = await getAnnotationRecord(session, scope);
  guard();
  if (
    record?.base?.state !== "ready" ||
    localBase.boundBaseId !== record.base.baseId
  )
    return localBase;
  let base = record.base;
  if (!base.layout?.compatibility) {
    const compatibility = await verifiedLegacySurfaceCompatibility(
      question,
      surface,
      localBase.layout,
    );
    guard();
    if (!compatibility) return localBase;
    try {
      const preview = await withTimeout(
        postAnnotationBaseApi(
          scope.attemptId,
          scope.questionId,
          scope.phase,
          { ...localBase.layout, compatibility },
          signal,
          record.resetVersion ?? 0,
        ),
        15_000,
        "续写兼容信息暂未同步",
      );
      guard();
      base = preview.base;
    } catch (cause) {
      guard();
      // 已严格核对的旧稿可离线继续；不把未确认的证据当作服务端事实。
      if (cause instanceof ApiError && cause.status < 500) throw cause;
      return localBase;
    }
  }
  await applyAnnotationBaseCompatibility(
    session,
    scope,
    base,
    record.resetVersion ?? 0,
    guard,
  );
  guard();
  const saved = await getAnnotationRecord(session, scope);
  guard();
  if (!saved?.localBase || saved.local !== "saved")
    throw new Error(saved?.localError ?? "续写布局未保存，请重试");
  return saved.localBase;
}
