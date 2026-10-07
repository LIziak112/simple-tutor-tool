/**
 * 服务端 head → 本地记录的播种共享核（T6R.15 闸门修复 F1 抽取）：
 * use-note-head（scratch 工作稿头）与 correction-record（订正行的合成头投影）
 * 两处播种骨架的单一实现——并发敏感的「serverAhead 判定 + 条件拉正文」不再
 * 两份复制（将来改判据如加 docVersion 比较只改此处）。
 *
 * 时序（闸门修复的关键变更）：服务端领先时**先 fetch 正文、成功后才落地
 * head 对齐与正文**（applyServerLoad 一次原子变更：applyHeadInfo 的
 * baseRevision/noteId/lastHead 对齐随正文一起落）。fetch 失败则**什么都不
 * 动**——本地基线保持原值，下一次 head 重拉时 serverAhead 判定仍成立、
 * 播种自然重试。旧时序（先 applyServerHead 对齐再 fetch）在 fetch 失败窗口
 * 内把基线钳到服务端 revision，此后 serverAhead 恒 false、正文永不重试——
 * 本地空稿可在无感知下以对齐后的基线 CAS 覆盖服务端内容（他端写的订正从
 * head 位消失）。失败窗口内本地保持原 base 的代价：期间的新写在极端竞态下
 * 以旧 base 上传撞 409——可诊断路径（冲突面板裁决），优于静默覆盖。
 *
 * 补图触发（仅 scratch 语境传 recoverImages，T6R.6「学生重新进入时触发」）：
 * head 的 images 含 failed/missing → recoverNoteImages 重建补传（不 await：
 * 补图不阻塞 head 应用；正文拉取与否都该补——本地领先时图片照样该恢复；
 * 确定性渲染 + 槽位幂等 upsert，重入安全）。
 */
import type { NoteHeadData } from "@tutor/contract";
import { recoverNoteImages } from "@/features/notes/image-sync";
import { hasBrokenRow } from "@/features/notes/note-image-state";
import {
  applyServerHead,
  applyServerLoad,
  type NoteScope,
  type NoteSessionRef,
  peekNoteRecord,
} from "@/features/notes/note-store";
import { fetchStudentNoteDocumentApi } from "@/lib/api";

/** 播种选项：recoverImages=true 时 head.images 含损坏行则触发补图（scratch 语境；订正行不在任何 head 图片投影里，不传） */
export interface SeedRecordOptions {
  recoverImages?: boolean;
}

/**
 * head 应用与条件播种（head 拉取成功后调用；失败不抛错——head 请求方的
 * queryFn 语义见 use-note-head）：
 * - 「服务端领先」判定取 head 应用**前**的快照（本地无记录 / noteId 变化 /
 *   服务端 revision 领先；之后判就永远不领先了——applyServerHead 会把
 *   baseRevision/noteId 对齐）；
 * - 领先 → 先 GET 版本文档，成功后 applyServerLoad（对齐 + 播种一次落地；
 *   本地未同步稿经 noteDocsEqual 比较保留，不被覆盖）；失败不动任何本地
 *   状态（见文件头时序说明）；
 * - 本地领先/已追平 → 仅 applyServerHead 对齐（省请求，上传自然追平）。
 */
export async function seedRecordFromServerHead(
  session: NoteSessionRef,
  scope: NoteScope,
  head: NoteHeadData,
  options?: SeedRecordOptions,
): Promise<void> {
  const note = head.note;
  const versionId = note?.currentVersionId ?? null;
  const before = peekNoteRecord(session, scope);
  const serverAhead =
    versionId !== null &&
    note !== null &&
    (before === null ||
      before.noteId !== note.noteId ||
      before.baseRevision < note.revision);

  // 补图触发（损坏行存在性谓词：[missing,pending] 混合态不漏判；空数组 →
  // false 与原口径一致）
  if (
    options?.recoverImages === true &&
    versionId !== null &&
    hasBrokenRow(head.images)
  ) {
    void recoverNoteImages({
      role: "student",
      versionId,
    }).catch((err: unknown) => {
      console.warn("草稿补图恢复失败（可用状态栏的重试入口再试）", err);
    });
  }

  if (!serverAhead) {
    // 本地领先/已追平：只对齐 head（lastHead/images 维度照常更新），省请求
    await applyServerHead(session, scope, head);
    return;
  }
  try {
    const raw = await fetchStudentNoteDocumentApi(versionId);
    // 对齐随正文一起落地（applyServerLoad 内部走 applyHeadInfo——含代际
    // 回退检测守卫）；revision=0 的空白新行不会走到这里（serverAhead 已拦）
    await applyServerLoad(session, scope, raw, head);
  } catch (err) {
    // 正文拉取失败不抛错：本地稿（若有）继续可用，且基线未被对齐——下一次
    // head 重拉时 serverAhead 仍成立，播种自然重试（闸门修复 F1 的核心）
    console.warn(
      "笔记正文拉取失败（本地稿不受影响，将随下次刷新重试播种）",
      err,
    );
  }
}
