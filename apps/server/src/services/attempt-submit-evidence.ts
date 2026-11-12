import type {
  NoteSubmissionEvidenceState,
  SubmitEvidenceDeclaration,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NoteRow, notes } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertExactQuestionSet } from "./attempt-submit-revisions.ts";

/**
 * 交卷要写的逐题证据行（T6R.10，方案 §6.4）——在提交事务中验证，
 * 写入与判分同事务（见 submitAttempt）。
 *
 * 声明语义（契约 submitEvidenceDeclarationSchema）：
 * - frozen：versionId/revision 与服务端实际 head **精确比对**（归属已由
 *   attemptId+questionId 圈定——notes 行只能经本人 attempt 的写通道产生）；
 *   其他标签页/设备改出新 head ⇒ 409 拒绝这次冻结，不静默固定旧版；
 * - none：实际存在草稿（scratch 行 head revision>0）时矛盾 ⇒ 409——
 *   用户未确认不能静默 missing/none；
 * - missing：用户已明确选择「提交答案，草稿未保存完整」（确认动作在
 *   客户端交卷流程承担），服务端如实记录、不叠加上传状态校验。
 *
 * 旧客户端（缺 evidence 字段）：检测到**参与本次判分题目的**草稿存在 ⇒ 409
 * 要求刷新（不能把已有草稿记 none）；确无草稿按兼容规则交卷——**不落证据行**
 * （= 未采集，与 state='none'〔明确空稿〕区分）。graded 范围 = 本次交卷要
 * 判分的行（lesson 与新协议普通卷整卷收尾只含未提交题——已单题提交题的
 * 证据已在该题提交事务冻结，其草稿不再阻塞收尾；历史协议为全部冻结题）。
 *
 * 新客户端：声明集合必须与 graded 范围精确一致（缺项/多项/未知/重复
 * 同 409，口径同 validateSubmitRevisions）。
 */
export function buildSubmissionEvidence(
  db: Pick<Db, "select">,
  attemptId: string,
  graded: readonly { response: { questionId: string } }[],
  declarations: readonly SubmitEvidenceDeclaration[] | undefined,
): Array<{
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
}> {
  const noteRows = db
    .select()
    .from(notes)
    .where(and(eq(notes.attemptId, attemptId), eq(notes.phase, "scratch")))
    .all();
  const noteByQuestion = new Map(
    noteRows.map((n) => [n.questionId, n] as const),
  );

  if (declarations === undefined) {
    // 旧客户端：范围内有草稿 ⇒ 拒绝并要求刷新；无草稿 ⇒ 兼容交卷（未采集=无行）
    const scope = new Set(graded.map((g) => g.response.questionId));
    if (
      noteRows.some((n) => n.currentRevision > 0 && scope.has(n.questionId))
    ) {
      throw evidenceMismatch("这份练习有尚未固定的草稿，请刷新页面后重新交卷");
    }
    return [];
  }

  // 新客户端：集合精确比对（口径同 validateSubmitRevisions，错误码经工厂差异化）
  assertExactQuestionSet(graded, declarations, () =>
    evidenceMismatch("笔记证据声明与试卷题目不一致，请刷新页面后重新交卷"),
  );

  return declarations.map((decl) =>
    evidenceRowOfDeclaration(noteByQuestion.get(decl.questionId), decl),
  );
}

/**
 * 单条证据声明的验证核心（整卷 buildSubmissionEvidence 与 lesson 单题
 * buildSingleQuestionEvidence 共用，语义见上方注释块）：
 * 返回要写的证据行；任何不符抛 409 NOTE_EVIDENCE_MISMATCH。
 */
function evidenceRowOfDeclaration(
  note: NoteRow | undefined,
  decl: SubmitEvidenceDeclaration,
): {
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
} {
  if (decl.state === "frozen") {
    if (
      note === undefined ||
      note.currentVersionId !== decl.versionId ||
      note.currentRevision !== decl.revision
    ) {
      throw evidenceMismatch(
        "草稿状态已变化（可能其他设备刚保存了新版本），请重新交卷",
      );
    }
    return {
      questionId: decl.questionId,
      state: "frozen" as const,
      versionId: decl.versionId,
    };
  }
  if (decl.state === "none") {
    if (note !== undefined && note.currentRevision > 0) {
      throw evidenceMismatch(
        "该题存在未固定的草稿，请返回处理后再交卷（或刷新页面查看最新草稿）",
      );
    }
    return {
      questionId: decl.questionId,
      state: "none" as const,
      versionId: null,
    };
  }
  // missing（复审接受项）：到达此分支时服务端可能已有该题矢量（客户端
  // 分类窗口的竞态——声明组装后、提交落地前他处上传成功）。按用户明示
  // 选择如实记录 missing，**不自动升格 frozen**：本地可能还有更新的未传
  // 内容，升格会把陈旧 head 伪装成原稿；已落地内容经 T6R.15 supplement
  // 找回，不冒称原稿
  return {
    questionId: decl.questionId,
    state: "missing" as const,
    versionId: null,
  };
}

/**
 * lesson 单题提交的证据验证（T6R.10 语义单题化，2026-10 讲练一体）：
 * - 声明缺省 = 旧客户端——该题存在草稿（scratch 行 head revision>0）⇒ 409
 *   拒绝、确无草稿不落行（未采集，与整卷兼容规则同口径）；
 * - 声明携带时 evidence.questionId 必须与路径 questionId 一致（否则 409
 *   NOTE_EVIDENCE_MISMATCH——契约注释「须与路径一致，服务端校验」）；
 * - 逐声明验证复用 evidenceRowOfDeclaration（与整卷同一实现，不复制语义）。
 * 在提交事务中验证；返回 null = 本次提交不落证据行。
 */
export function buildSingleQuestionEvidence(
  db: Pick<Db, "select">,
  attemptId: string,
  questionId: string,
  decl: SubmitEvidenceDeclaration | undefined,
): {
  questionId: string;
  state: NoteSubmissionEvidenceState;
  versionId: string | null;
} | null {
  const note = db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.attemptId, attemptId),
        eq(notes.questionId, questionId),
        eq(notes.phase, "scratch"),
      ),
    )
    .get();
  if (decl === undefined) {
    if (note !== undefined && note.currentRevision > 0) {
      throw evidenceMismatch("这道题有尚未固定的草稿，请刷新页面后重新提交");
    }
    return null;
  }
  if (decl.questionId !== questionId) {
    throw evidenceMismatch(
      "笔记证据声明与提交的题目不一致，请刷新页面后重新提交",
    );
  }
  return evidenceRowOfDeclaration(note, decl);
}

/** 证据声明验证失败的统一拒绝（T6R.10，409；前端据此刷新/重走交卷流程） */
function evidenceMismatch(message: string): HttpError {
  return new HttpError(409, "NOTE_EVIDENCE_MISMATCH", message);
}
