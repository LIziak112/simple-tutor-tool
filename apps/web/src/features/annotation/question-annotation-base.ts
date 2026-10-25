import type { AttemptQuestionPublic } from "@tutor/contract";
import { withTimeout } from "@/features/notes/rasterize-utils";
import {
  ApiError,
  fetchAnnotationViewApi,
  studentAnnotationBasePngUrl,
} from "@/lib/api";
import { measureStage } from "@/lib/performance-stages";
import {
  type AnnotationLocalRecord,
  type AnnotationScope,
  type AnnotationSessionRef,
  applyAnnotationView,
  getAnnotationRecord,
  retryAnnotationPersistence,
  settleAnnotationRecordPersistence,
  writeLocalAnnotationBase,
} from "./annotation-store";
import { currentAnnotationSession } from "./annotation-sync";
import {
  questionSurfaceMatchesLayout,
  renderQuestionBaseImage,
} from "./question-base-image";
import {
  cancelOtherQuestionBasePrewarm,
  takePrewarmedQuestionBase,
} from "./question-base-prewarm";
import { questionBaseRenderQueue } from "./question-base-render-queue";

/** 云端底图 PNG 下载：失败后退避约 1s 重试一次（每次仍走 15s 超时）；
 * 取消与会话切换由 guard 在等待间隙同样拦截（直接抛出，不重试）；
 * 两次都失败才抛「原标画底图下载失败，请重试」。 */
async function fetchCloudBasePngWithRetry(
  url: string,
  guard: () => void,
): Promise<Blob> {
  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      guard();
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch {
      continue; // 网络中断或超时：退避后重试一次
    }
    guard();
    if (!response.ok) continue;
    let png: Blob;
    try {
      png = await response.blob();
    } catch {
      continue; // 字节流读取失败同样按下载失败重试
    }
    guard();
    return png;
  }
  throw new Error("原标画底图下载失败，请重试");
}

export type QuestionAnnotationBaseResult =
  | {
      kind: "surface";
      localBase: NonNullable<AnnotationLocalRecord["localBase"]>;
    }
  | { kind: "sealed" }
  /** v1 旧版底图（无 layout）：旧稿可查看不可编辑，上层转只读原圈画弹窗。 */
  | { kind: "legacy" };

/** 只由当前题显式调用；全局最多一个栅格任务，缓存不等待网络。
 * surface 允许 null（B05 AI 材料采集）：已保存底图不需要活题面；只有需要
 * 新渲染的路径要求题面挂载，缺挂载给明确可重试错误，不当作空稿。 */
export async function prepareQuestionAnnotationBase(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement | null,
  signal?: AbortSignal,
): Promise<QuestionAnnotationBaseResult> {
  const guard = () => {
    if (signal?.aborted) throw new DOMException("标画打开已取消", "AbortError");
    if (currentAnnotationSession() !== session)
      throw new Error("标画会话已切换，请重新打开");
  };
  guard();
  cancelOtherQuestionBasePrewarm(session, scope);
  if (scope.questionId !== question.id) throw new Error("标画题目标识不匹配");
  const cached = await getAnnotationRecord(session, scope);
  guard();
  if (cached?.localBase != null) {
    await settleAnnotationRecordPersistence(session, scope);
    guard();
    await retryAnnotationPersistence(session, scope);
    guard();
    const saved = await getAnnotationRecord(session, scope);
    guard();
    if (saved?.local !== "saved" || !saved.localBase)
      throw new Error(saved?.localError ?? "本机底图未保存，请重试");
    return { kind: "surface", localBase: saved.localBase };
  }
  if (cached?.base != null && cached.base.layout === undefined)
    // v1 旧版底图无布局证据：可查看旧稿，不当失败操作要求重开练习。
    return { kind: "legacy" };
  // 云端回填可能清理控件候选；先接管在途或已完成的预备，再核对云端。
  // surface 为 null（材料收起/未挂载）时跳过预备接管：预备只为加速新渲染。
  const candidatePromise =
    surface === null
      ? Promise.resolve(null)
      : takePrewarmedQuestionBase(session, scope, question, surface);
  let remoteDoc = cached?.pending?.doc ?? null;
  let base = cached?.base ?? null;
  try {
    const view = await measureStage("annotation:base-state", () =>
      withTimeout(
        fetchAnnotationViewApi(scope.attemptId, scope.questionId, scope.phase),
        15_000,
        "底图状态加载超时，改为本机保存",
      ),
    );
    guard();
    if (view.annotation?.sealedAt != null) return { kind: "sealed" };
    if ((view.resetVersion ?? 0) > (cached?.resetVersion ?? 0))
      remoteDoc = null;
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
    return { kind: "legacy" };
  if (base?.state === "ready" && base.layout !== undefined) {
    const png = await fetchCloudBasePngWithRetry(
      studentAnnotationBasePngUrl(scope.attemptId, base.baseId),
      guard,
    );
    const layout = base.layout;
    await measureStage("annotation:local-save", () =>
      writeLocalAnnotationBase(
        session,
        scope,
        { png, layout },
        remoteDoc ?? {
          version: 1,
          baseWidth: base.pixelWidth ?? 0,
          baseHeight: base.pixelHeight ?? 0,
          strokes: [],
        },
        { boundBaseId: base.baseId },
      ),
    );
  } else {
    // 无 ready 云端底图也无预备：必须从活题面渲染；未挂载明确失败可重试。
    if (surface === null) throw new Error("题面尚未就绪，请重试");
    const surfaceElement = surface;
    const possible = await candidatePromise;
    guard();
    // 状态回填之后再次核对，不能使用点击前已经失效的题面快照。
    const candidate =
      possible &&
      (await questionSurfaceMatchesLayout(
        question,
        surfaceElement,
        possible.layout,
      ))
        ? possible
        : null;
    guard();
    const rendered =
      candidate ??
      (await questionBaseRenderQueue.run(async () => {
        guard();
        return renderQuestionBaseImage(question, surfaceElement, {
          ...(signal ? { signal } : {}),
          shouldAbort: () => currentAnnotationSession() !== session,
        });
      }));
    guard();
    if (
      base?.layout !== undefined &&
      JSON.stringify(base.layout) !== JSON.stringify(rendered.layout)
    )
      throw new Error("另一设备已绑定不同布局，不能替换；请查看原标画");
    await measureStage("annotation:local-save", () =>
      writeLocalAnnotationBase(
        session,
        scope,
        { png: rendered.blob, layout: rendered.layout },
        remoteDoc ?? {
          version: 1,
          baseWidth: rendered.pixelWidth,
          baseHeight: rendered.pixelHeight,
          strokes: [],
        },
      ),
    );
  }
  guard();
  const saved = await getAnnotationRecord(session, scope);
  guard();
  if (!saved?.localBase || saved.local !== "saved")
    throw new Error("本机底图未保存，请重试");
  return { kind: "surface", localBase: saved.localBase };
}
