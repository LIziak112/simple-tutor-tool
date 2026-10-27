/**
 * 订正检查点的标注封存例程（2026-10 订正重构）：原 AnnotationLayer 内嵌的
 * 「保存订正标注」按钮随独立入口一并移除——订正工作台（CorrectionWorkspace）
 * 的「保存订正」统一封存草稿与圈画，一层检查点。
 *
 * 语义（沿袭原实现）：
 * - 先 catchUpAnnotations(attemptId) 追平（本地落盘 → 上传队列 → 回执落地），
 *   判定以追平后的本题 correction 记录为准；
 * - 无记录 → 返回 0（不算错误、不触发封存——空白不产生检查点）；
 * - conflict / denied / pending 未清 → 抛中文错误（由调用方就地展示）——
 *   同步异常先于「无内容」判定，上传失败不被静默当作无圈画；
 * - baseRevision=0 或 0 笔 → 返回 0，不触发封存；
 * - sealAttemptAnnotationsApi 是 attempt 级封存（服务端封该 attempt 全部未
 *   封存 correction 标注行）：订正工作台一次一题，本题主动的封存顺带定格
 *   其他题留在编辑中的订正圈画——检查点语义下可接受（笔迹保留只读）。
 */

import { sealAttemptAnnotationsApi } from "@/lib/api";
import { getAnnotationRecord } from "./annotation-store";
import {
  catchUpAnnotations,
  currentAnnotationSession,
} from "./annotation-sync";

/** 封存结果：本次实际封存的本题笔数（0=本题无圈画，未触发封存） */
export async function sealCorrectionAnnotation(options: {
  attemptId: string;
  questionId: string;
}): Promise<number> {
  const session = currentAnnotationSession();
  if (session === null) {
    throw new Error("标注会话未绑定，请刷新后重试");
  }
  const scope = {
    attemptId: options.attemptId,
    questionId: options.questionId,
    phase: "correction" as const,
  };
  // 先追平：本地落盘 → 上传队列 → 回执落地（封存判定以追平后 record 为准）
  await catchUpAnnotations(options.attemptId);
  const record = await getAnnotationRecord(session, scope);
  if (record === null) {
    return 0;
  }
  if (record.conflict !== null) {
    throw new Error("订正圈画有同步冲突待处理，请先在圈画区选择保留哪一份。");
  }
  if (record.denied !== null) {
    throw new Error(`订正圈画同步被拒：${record.denied.reason}`);
  }
  if (record.pending !== null) {
    throw new Error("订正圈画的最新修改还没同步完成，请稍候再试。");
  }
  const strokeCount = record.doc?.strokes.length ?? 0;
  if (record.baseRevision === 0 || strokeCount === 0) {
    return 0;
  }
  await sealAttemptAnnotationsApi(options.attemptId, "correction");
  return strokeCount;
}
