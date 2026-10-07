/**
 * 订正/补充稿的本地记录编排（T6R.15 前端，方案 §5.2/§6.4）：CorrectionSection
 * （结果页订正区）消费的三个动作 + 两个纯判定——
 * - openCorrectionOf：head.corrections 里找未封存行（sealedAt==null；
 *   D1「未封存至多一行」，服务层保证）；
 * - seedOpenCorrection：把未封存行对齐进本地 correction 记录（合成
 *   {note:row, images:[]} 走 applyServerHead/applyServerLoad——订正行不在
 *   工作稿头端点的 note 位，但记录形态同构；serverAhead 口径照 use-note-head：
 *   本地无记录/noteId 变化/服务端 revision 领先才拉正文播种，本地领先省请求）；
 * - recoverScratchAsSupplement（D8「找回草稿为补充稿」）：本地 scratch 的
 *   未同步内容复制到 phase='supplement' 新记录并触发同步（writeNoteDoc 生成
 *   pending → note-store 通知 → 会话队列按 phase 上送）；scratch 本地记录
 *   保留不动（未同步内容不静默删除）。**明确动作、不自动重传**——找回的
 *   材料只能作补充（结构性进不了 submission_evidence，服务端 D4 保证）。
 */

import type {
  NoteHeadData,
  NoteRecordMeta,
} from "@tutor/contract";
import {
  applyServerHead,
  applyServerLoad,
  getNoteRecord,
  type NoteLocalRecord,
  type NoteSessionRef,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { fetchStudentNoteDocumentApi } from "@/lib/api";

/** correction 头查询键（含学生 id：切账号不回放缓存的他人头；口径照 studentNoteHeadKey） */
export function correctionHeadKey(
  studentId: string,
  attemptId: string,
  questionId: string,
): readonly string[] {
  return ["student", studentId, "correction-head", attemptId, questionId];
}

/** head 里的未封存订正行（sealedAt==null；无则 null）。D1 保证至多一行 */
export function openCorrectionOf(head: NoteHeadData): NoteRecordMeta | null {
  for (const row of head.corrections) {
    if (row.sealedAt === null || row.sealedAt === undefined) return row;
  }
  return null;
}

/**
 * D8 找回判定（纯函数，兼类型谓词）：本地 scratch 记录是否有「未同步
 * 内容」——有笔迹且（有待传版本 或 从未上送过版本）。已全同步的内容
 * 服务端工作稿已持有（找回不产生新信息），空稿没有可找回的内容。
 */
export function hasRecoverableScratch(
  record: NoteLocalRecord | null,
): record is NoteLocalRecord {
  if (record === null) return false;
  if (record.doc.ink.strokes.length === 0) return false;
  return record.pending !== null || record.noteId === null;
}

/**
 * 未封存订正行对齐 + 条件播种（CorrectionSection 展开 head / 创建订正
 * 成功后调用）。正文拉取失败不抛错（本地稿不受影响，下一次 head 重试播种
 * ——口径同 use-note-head 的 applyNoteHeadSideEffects）。
 */
export async function seedOpenCorrection(
  session: NoteSessionRef,
  attemptId: string,
  questionId: string,
  head: NoteHeadData,
): Promise<void> {
  const row = openCorrectionOf(head);
  if (row === null) return;
  const scope = { attemptId, questionId, phase: "correction" as const };
  // 「服务端领先」判定取 head 应用前的快照（口径照 use-note-head：之后判
  // 就永远不领先了）
  const before = peekNoteRecord(session, scope);
  const serverAhead =
    row.currentVersionId !== null &&
    (before === null ||
      before.noteId !== row.noteId ||
      before.baseRevision < row.revision);
  // 订正行不在工作稿头端点的 note 位——合成同构头投影（images/evidence/
  // 集合与本行无关，空态；lastHead 只被 overview.images 消费，订正语境恒
  // 空数组=图片维度不提示）
  const syntheticHead: NoteHeadData = {
    note: row,
    images: [],
    evidence: null,
    corrections: [],
    supplements: [],
  };
  await applyServerHead(session, scope, syntheticHead);
  if (!serverAhead) return;
  // revision=0 空白新行无版本可读（currentVersionId null 已被 serverAhead 拦下，
  // 此处防御性复核）
  if (row.currentVersionId === null) return;
  try {
    const raw = await fetchStudentNoteDocumentApi(row.currentVersionId);
    await applyServerLoad(session, scope, raw, syntheticHead);
  } catch (err) {
    console.warn("订正正文拉取失败（本地稿不受影响）", err);
  }
}

/** D8 找回结果：copied=已复制到补充稿并触发同步 / nothing=无可找回内容 */
export type RecoverOutcome = "copied" | "nothing";

/**
 * 找回草稿为补充稿（D8，用户明确动作）：本地 scratch 的未同步内容复制到
 * phase='supplement' 记录（同 attempt 同题——补充稿归属该轮作答）。写入即
 * 生成 pending（新 mutationId）并经 store 通知触发同步；scratch 本地记录
 * 保留不动。无可找回内容时 no-op。
 */
export async function recoverScratchAsSupplement(
  session: NoteSessionRef,
  attemptId: string,
  questionId: string,
): Promise<RecoverOutcome> {
  const scratch = await getNoteRecord(session, {
    attemptId,
    questionId,
    phase: "scratch",
  });
  if (!hasRecoverableScratch(scratch)) return "nothing";
  // writeNoteDoc 接受 NoteDocInput——scratch.doc 即仓内对象（整体替换纪律：
  // 交出后调用方不得再改），两个 scope 各持一份引用互不影响（后续任一侧
  // 写入都会整体换新对象，不就地共享）
  writeNoteDoc(
    session,
    { attemptId, questionId, phase: "supplement" },
    scratch.doc,
  );
  return "copied";
}
