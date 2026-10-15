import type { AttemptQuestionPublic } from "@tutor/contract";
import { getAnnotationRecord } from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import { exportQuestionAnnotationImage } from "@/features/annotation/export-question-annotation";
import { renderQuestionBaseImage } from "@/features/annotation/question-base-image";
import {
  attemptMaterialsEditable,
  getAttemptRecoveryState,
} from "@/features/attempt/attempt-material-recovery";
import {
  draftStore,
  getDraftSessionEpoch,
} from "@/features/attempt/draft-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import {
  createOngoingQuestionImages,
  loadImage,
  loadOngoingPaper,
  type OngoingComposedPage,
  type OngoingPaper,
} from "./ongoing-question-export";

/**
 * AI 伴学手写材料采集（B05 SAI-10）：发送动作的共用采集入口。
 * 从「导出本题」抽取同一套固定材料链路——收笔 → 本机落盘确认 → 恢复/冲突
 * 核对 → 固定矢量重绘 → 分页 PNG——不重写绘图算法；原单题导出入口不变。
 *
 * 权威语义（批次 B05「精确执行顺序」8 条）：
 * 1. 调用即锁定账号会话（note/annotation session + draft epoch）、attempt、
 *    题目版本（questionRevisionId）、阶段与材料选择；全程 guard 校验未变。
 * 2. 只对选定题收笔并等待该题本机落盘；不等整卷云端同步，也不跳过本机保存失败。
 * 3. 材料恢复完成（verified 才可离线续用）、无待裁决冲突才继续；旧键迁移走既有归属流程。
 * 4. 全部从固定矢量/已保存底图/持久记录读取；收起或卸载画布不当空。
 * 5. 圈画走原底图配套合成（CSS 几何配对）；草稿/正式手写走固定矢量重绘 +
 *    完整分页；预测点不入图（重绘输入是持久文档，非活动画布）。
 * 6. 输出快照草案（版本/页序/尺寸/来源类别/字节）；不写库、不改正式稿与交卷证据指针。
 * 7. 任一步失败或标识变化即停止并给缺件原因；不触碰原稿/undo/输入。
 * 8. 重试传入 previous 且标识一致时原样复用，不后台重抓最新稿；是否更新由发送控制器决定。
 */

/** 与服务端 AiOutboundMaterialRef.kind 对齐（SAI-09 student-ai-context 占位）。 */
export type AiMaterialKind = "annotation" | "draft" | "formal_ink";

export interface AiMaterialSelection {
  readonly annotation: boolean;
  readonly draft: boolean;
  readonly formalInk: boolean;
}

/** 失败环节：发送控制器据此提示缺件与减选/仅文字选项。 */
export type AiCaptureStage =
  | "identity"
  | "flush"
  | "recovery"
  | "conflict"
  | "annotation"
  | "paper"
  | "compose";

/** 采集失败（不发送、不清稿、不产生空白假图）；material 为缺件类别。 */
export class AiCaptureError extends Error {
  readonly stage: AiCaptureStage;
  readonly material: AiMaterialKind | null;
  constructor(
    message: string,
    stage: AiCaptureStage,
    material: AiMaterialKind | null = null,
  ) {
    super(message);
    this.name = "AiCaptureError";
    this.stage = stage;
    this.material = material;
  }
}

export interface AiCaptureInput {
  readonly attemptId: string;
  readonly question: AttemptQuestionPublic;
  /** 手写题（solve/apply/find-error）采集正式手写，其余题型采集草稿。 */
  readonly isHandwritten: boolean;
  readonly selection: AiMaterialSelection;
  /** 页面题头（如「第 27 题 · 作业名」）。 */
  readonly title: string;
  /** 当前题面元素；已保存底图路径不需要它，可为 null（材料收起/未挂载）。 */
  readonly surface: HTMLElement | null;
  /** 收笔并等待本题本机落盘；UI 从 AttemptEditorContext.flush 注入。 */
  readonly flush: (questionId: string) => Promise<void>;
  /** 重试时带上上次快照：同一采集不重抓最新稿（顺序 8）。 */
  readonly previous?: AiCaptureSnapshot | null;
}

export interface AiCapturedPage {
  readonly kind: AiMaterialKind;
  /** 类别内页序，从 0 起；跨类别顺序恒为 annotation → draft/formal_ink。 */
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly blob: Blob;
}

/** 快照草案：发送控制器据此装配任务材料；本模块不落库不改指针。 */
export interface AiCaptureSnapshot {
  /** 结构版本（演进时递增） */
  readonly version: 1;
  readonly attemptId: string;
  readonly questionId: string;
  readonly questionRevisionId: string;
  readonly phase: "scratch";
  readonly capturedAt: number;
  readonly selection: AiMaterialSelection;
  readonly pages: readonly AiCapturedPage[];
}

function sameSelection(
  a: AiMaterialSelection,
  b: AiMaterialSelection,
): boolean {
  return (
    a.annotation === b.annotation &&
    a.draft === b.draft &&
    a.formalInk === b.formalInk
  );
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export async function captureAiQuestionMaterials(
  input: AiCaptureInput,
): Promise<AiCaptureSnapshot> {
  const { attemptId, question, isHandwritten, selection } = input;
  const paperKind: AiMaterialKind = isHandwritten ? "formal_ink" : "draft";
  const wantsPaper = isHandwritten ? selection.formalInk : selection.draft;
  // 1. 锁定会话与题目标识（账号切换/讲练重开即失效）。
  const noteSession = currentNoteSession();
  const annotationSession = currentAnnotationSession();
  const draftEpoch = getDraftSessionEpoch();
  if (!noteSession || !annotationSession)
    throw new AiCaptureError("作答材料会话尚未就绪，请重试", "identity");
  const guard = () => {
    if (
      currentNoteSession() !== noteSession ||
      currentAnnotationSession() !== annotationSession ||
      getDraftSessionEpoch() !== draftEpoch
    )
      throw new AiCaptureError("会话已切换，本次采集已停止", "identity");
  };
  // 8. 同一采集重试：标识与选择一致时复用原快照，不重抓最新稿。
  const previous = input.previous ?? null;
  if (
    previous !== null &&
    previous.attemptId === attemptId &&
    previous.questionId === question.id &&
    previous.questionRevisionId === question.questionRevisionId &&
    sameSelection(previous.selection, selection)
  )
    return previous;
  const scope = {
    attemptId,
    questionId: question.id,
    phase: "scratch" as const,
  };
  // 2. 选定题收笔 + 等待该题本机落盘（保存失败即停，绝不假成功）。
  try {
    await input.flush(question.id);
  } catch (cause) {
    throw new AiCaptureError(
      messageOf(cause, "本机稿未保存，请重试保存后再发送"),
      "flush",
    );
  }
  guard();
  // 3. 材料恢复与冲突核对（读取失败不视为无稿）。
  const recovery = getAttemptRecoveryState(attemptId);
  if (!attemptMaterialsEditable(recovery))
    throw new AiCaptureError(
      recovery.state === "failed"
        ? recovery.message
        : "作答材料尚未恢复完成，请稍后重试",
      "recovery",
    );
  const annotationRecord = selection.annotation
    ? await getAnnotationRecord(annotationSession, scope)
    : null;
  guard();
  if (annotationRecord?.conflict || annotationRecord?.denied)
    throw new AiCaptureError(
      "题面圈画同步冲突或被拒，请处理后重试",
      "conflict",
      "annotation",
    );
  if (
    wantsPaper &&
    isHandwritten &&
    draftStore.peekAnswerConflicts(attemptId)[question.id] !== undefined
  )
    throw new AiCaptureError(
      "手写作答存在待裁决冲突，请先选择保留版本",
      "conflict",
      "formal_ink",
    );
  const pages: AiCapturedPage[] = [];
  // 5a. 圈画：原底图配套合成（题面 + 标画同域坐标；收起仍可从已保存底图取）。
  if (
    selection.annotation &&
    (annotationRecord?.doc?.strokes.length ?? 0) > 0
  ) {
    let blob: Blob;
    try {
      blob = await exportQuestionAnnotationImage(
        annotationSession,
        scope,
        question,
        input.surface,
      );
    } catch (cause) {
      throw new AiCaptureError(
        messageOf(cause, "题面圈画读取失败，请重试"),
        "annotation",
        "annotation",
      );
    }
    guard();
    let image: HTMLImageElement;
    try {
      image = await loadImage(blob);
    } catch {
      throw new AiCaptureError(
        "圈画图片读取失败，请重试",
        "annotation",
        "annotation",
      );
    }
    guard();
    pages.push({
      kind: "annotation",
      pageIndex: 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
      byteSize: blob.size,
      blob,
    });
  }
  // 5b. 草稿/正式手写：固定矢量重绘 + 完整分页，每页携带公开题面。
  if (wantsPaper) {
    let paper: OngoingPaper | null;
    try {
      paper = await loadOngoingPaper(
        noteSession,
        attemptId,
        question.id,
        isHandwritten,
      );
    } catch (cause) {
      throw new AiCaptureError(
        messageOf(cause, "书写材料读取失败，请重试"),
        "paper",
        paperKind,
      );
    }
    guard();
    if (paper) {
      // 草稿/手写页不带未选定的圈画：用不带标画的公开题面合成。
      if (!input.surface)
        throw new AiCaptureError("题面尚未就绪，请重试", "paper", paperKind);
      let questionBlob: Blob;
      try {
        questionBlob = (await renderQuestionBaseImage(question, input.surface))
          .blob;
      } catch (cause) {
        throw new AiCaptureError(
          messageOf(cause, "题面渲染失败，请重试"),
          "compose",
          paperKind,
        );
      }
      guard();
      let composed: OngoingComposedPage[];
      try {
        composed = await createOngoingQuestionImages(
          questionBlob,
          paper,
          input.title,
          () => {
            guard();
          },
          false,
        );
      } catch (cause) {
        // guard 抛出的 identity 错误保持原环节，不降级为合成失败。
        if (cause instanceof AiCaptureError) throw cause;
        throw new AiCaptureError(
          messageOf(cause, "材料页合成失败，请重试"),
          "compose",
          paperKind,
        );
      }
      composed.forEach((page, index) => {
        pages.push({
          kind: paperKind,
          pageIndex: index,
          width: page.width,
          height: page.height,
          byteSize: page.blob.size,
          blob: page.blob,
        });
      });
    }
    // paper === null：该类别无稿（尚无笔迹）不算失败，可继续仅文字发送（需求 §4.1）。
  }
  return {
    version: 1,
    attemptId,
    questionId: question.id,
    questionRevisionId: question.questionRevisionId,
    phase: "scratch",
    capturedAt: Date.now(),
    selection: {
      annotation: selection.annotation,
      draft: selection.draft,
      formalInk: selection.formalInk,
    },
    pages,
  };
}
