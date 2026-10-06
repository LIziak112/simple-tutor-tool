/**
 * 交卷证据声明组装（T6R.10，方案 §6.4「首版交卷：固定矢量，图片不阻塞」）：
 * 确认交卷时——等待本地落盘事务 → flushNoteSync 追平最终矢量并**消费其
 * 结果摘要**（conflict/denied/backoff/dirty 的键如实呈现，绝不把 flush
 * 返回当完成）→ 逐题拉取服务端 head（versionId/revision 的权威口径——
 * 跨设备/他标签页/丢回执都收敛到服务端事实）→ 产出每题声明：
 * - frozen：服务端 head 存在且本地无未追平改动 → 固定 head 版本
 *   （versionId+revision 原样回传，服务端 CAS 精确比对——head 又前进则
 *   409 NOTE_EVIDENCE_MISMATCH，前端提示重试交卷，不静默固定旧版）；
 * - none：确无草稿（本地无记录或空稿，且服务端无笔记行）；
 * - missing：**仅**用户明确选择「提交答案，草稿未保存完整」后
 *   （allowMissing 传入该题）——服务端记录 missing，本地稿保留，
 *   之后找回只能作为 supplement（T6R.15），不冒称原稿。
 *
 * 未决问题（不在 allowMissing 内的 conflict/denied/backoff/dirty/防御态）
 * → declarations=null 阻止交卷，由 SubmitConfirmDialog 呈现并给出明确选择。
 * PNG 不阻塞：本模块不触碰图片派生队列（后台补图，补图只能挂既定版本）。
 */
import type { SubmitEvidenceDeclaration } from "@tutor/contract";
import { fetchStudentNoteHeadApi } from "@/lib/api";
import { currentNoteSession, flushNoteSync } from "./note-sync.ts";
import {
  getNoteRecord,
  settleNotePersistence,
  type NoteLocalRecord,
  type NoteScope,
} from "./note-store.ts";

/** 逐题展示分类（SubmitConfirmDialog 草稿状态区） */
export type SubmitNoteStatusKind =
  /** 已同步、交卷时固定为原稿 */
  | "will-freeze"
  /** 未追平/被拒/冲突——需处理或明确选择缺稿交卷 */
  | "problem"
  /** 用户已确认按缺稿交卷（missing） */
  | "missing"
  /** 未写草稿 */
  | "none";

export interface SubmitNoteStatus {
  questionId: string;
  kind: SubmitNoteStatusKind;
  /** kind=problem 时的中文原因（用户可读） */
  reason: string | null;
}

export interface SubmitEvidenceProblem {
  questionId: string;
  reason: string;
}

export interface SubmitEvidencePrep {
  /**
   * 全部题目可声明时为完整声明数组（与冻结题目集合一一对应）；
   * 仍有未决问题（不在 allowMissing 内）时为 null——交卷被阻止。
   */
  declarations: SubmitEvidenceDeclaration[] | null;
  /** 逐题展示状态（与 questionIds 同序） */
  statuses: SubmitNoteStatus[];
  /** 未决问题清单（declarations=null 时非空） */
  problems: SubmitEvidenceProblem[];
}

/** 记录级未追平判定：pending/冲突/被拒任一非空（flush 摘要的记录态镜像） */
function problemReasonOf(record: NoteLocalRecord | null): string | null {
  if (record === null) return null;
  if (record.conflict !== null) {
    return "草稿与其他设备的版本冲突，需要先选择保留哪一份";
  }
  if (record.denied !== null) {
    return record.denied.kind === "content"
      ? "草稿超出保存限制，未能上传到服务器"
      : "草稿同步被拒绝（可能已失去访问权），请刷新后重试";
  }
  if (record.pending !== null) {
    return "草稿尚未保存完整（网络不稳定，正在重试）";
  }
  return null;
}

/**
 * 组装交卷证据声明（交卷确认流程的核心步骤；详见模块头）。
 * head 拉取失败（网络/权限）时抛错——状态未知不能声明，交卷流程据此
 * 提示重试并保持答题状态。
 */
export async function prepareSubmitEvidence(input: {
  attemptId: string;
  questionIds: readonly string[];
  /** 用户已明确选择缺稿交卷的题目（「草稿未保存完整」确认后重跑传入） */
  allowMissing?: ReadonlySet<string>;
}): Promise<SubmitEvidencePrep> {
  // ① 冻结编辑（模态弹层覆盖）后等本地事务 → 追平矢量 → 回执落盘再等一次
  await settleNotePersistence();
  const flushOutcome = await flushNoteSync();
  await settleNotePersistence();

  // ② 消费 flush 摘要：非 synced 的键 = 有未追平草稿（键形 attempt:question:phase，
  //    attemptId 是无冒号 UUID——首段定位 attempt、末段是 phase、中段是题目 id）
  const flushedBad = new Set<string>();
  for (const [key, outcome] of Object.entries(flushOutcome)) {
    if (outcome === "synced") continue;
    const first = key.indexOf(":");
    const last = key.lastIndexOf(":");
    if (first === -1 || last <= first) continue; // 防御：非本格式键不参与
    if (key.slice(0, first) !== input.attemptId) continue; // 其他卷的键不拦本卷
    flushedBad.add(key.slice(first + 1, last));
  }

  // ③ 逐题服务端 head（权威 versionId/revision；全部成功才可声明）
  const session = currentNoteSession();
  const heads = await Promise.all(
    input.questionIds.map((questionId) =>
      fetchStudentNoteHeadApi(input.attemptId, questionId),
    ),
  );

  // ④ 分类与声明
  const statuses: SubmitNoteStatus[] = [];
  const declarations: SubmitEvidenceDeclaration[] = [];
  const problems: SubmitEvidenceProblem[] = [];
  let blocked = false;

  for (let i = 0; i < input.questionIds.length; i += 1) {
    const questionId = input.questionIds[i]!;
    const head = heads[i]!;
    const scope: NoteScope = {
      attemptId: input.attemptId,
      questionId,
      phase: "scratch",
    };
    const record = session === null ? null : await getNoteRecord(session, scope);
    const hasServerNote = head.note !== null && head.note.revision > 0;

    // 未追平判定：记录态（conflict/denied/pending）∪ flush 摘要点名
    const reason = problemReasonOf(record) ?? (flushedBad.has(questionId)
      ? "草稿尚未保存完整（网络不稳定，正在重试）"
      : null);
    // 防御：本地有笔、无待传、服务端却无笔记行（内容从未到达服务端的
    // 数据不一致态）——不能静默 none，按问题呈现等用户处理/明确选择
    const contentNeverLanded =
      reason === null &&
      record !== null &&
      record.doc.ink.strokes.length > 0 &&
      !hasServerNote;

    if (reason !== null || contentNeverLanded) {
      const text =
        reason ?? "草稿内容尚未保存到服务器（数据不一致，请重试同步）";
      if (input.allowMissing?.has(questionId) === true) {
        // 用户已明确选择缺稿交卷：如实声明 missing（本地稿保留）
        statuses.push({ questionId, kind: "missing", reason: null });
        declarations.push({ questionId, state: "missing" });
        continue;
      }
      statuses.push({ questionId, kind: "problem", reason: text });
      problems.push({ questionId, reason: text });
      blocked = true;
      continue;
    }

    if (hasServerNote) {
      statuses.push({ questionId, kind: "will-freeze", reason: null });
      declarations.push({
        questionId,
        state: "frozen",
        versionId: head.note!.currentVersionId!,
        revision: head.note!.revision,
      });
      continue;
    }

    statuses.push({ questionId, kind: "none", reason: null });
    declarations.push({ questionId, state: "none" });
  }

  return {
    declarations: blocked ? null : declarations,
    statuses,
    problems,
  };
}

/**
 * 弹层打开时的本地快览（无网络、纯内存态）：统计各题草稿展示分类，
 * 供 SubmitConfirmDialog 在用户点确认前展示「已同步待固定/未保存/未写」。
 * 与 prepareSubmitEvidence 的权威判定不同步到毫秒——确认时会重跑组装，
 * 弹层文案只作引导提示。
 */
export async function snapshotNoteOverview(input: {
  attemptId: string;
  questionIds: readonly string[];
}): Promise<SubmitNoteStatus[]> {
  const session = currentNoteSession();
  const statuses: SubmitNoteStatus[] = [];
  for (const questionId of input.questionIds) {
    const record =
      session === null
        ? null
        : await getNoteRecord(session, {
            attemptId: input.attemptId,
            questionId,
            phase: "scratch",
          });
    const reason = problemReasonOf(record);
    if (reason !== null) {
      statuses.push({ questionId, kind: "problem", reason });
      continue;
    }
    if (record === null || record.doc.ink.strokes.length === 0) {
      statuses.push({ questionId, kind: "none", reason: null });
      continue;
    }
    statuses.push({ questionId, kind: "will-freeze", reason: null });
  }
  return statuses;
}
