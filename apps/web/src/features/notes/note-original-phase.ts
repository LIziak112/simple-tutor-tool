/**
 * 草稿原稿查看的纯函数层（T6R.11 复审收敛）：证据行 → 无稿原因/就绪元信息
 * 的判定与文案从组件抽出（组件 load 只剩 IO 与状态迁移）。互斥口径：
 * evidence === null → 未采集；state !== "frozen" → 该契约状态即原因；
 * frozen → 可渲染（resolveAbsentReason 返回 null，versionId 由契约
 * superRefine 保证非空——防御分支仍保留，按数据异常处理）。
 */
import type {
  NoteDoc,
  NoteHeadData,
  NoteSubmissionEvidenceMeta,
} from "@tutor/contract";
import { worstImageState } from "@/features/notes/note-image-state";

/** 无稿原因：契约状态直接作枚举（不为 kebab 改名单独维护映射） */
export type AbsentReason =
  | "not-collected"
  | Exclude<NoteSubmissionEvidenceMeta["state"], "frozen">;

/** 无稿族文案（四态互斥；「读取失败」不在此族——绝不能隐藏成无稿） */
export const ABSENT_TEXT: Record<AbsentReason, string> = {
  "not-collected":
    "本次交卷没有采集到草稿（旧版本客户端交卷，或交卷时未上传草稿）。",
  none: "本题交卷时没有草稿（交卷确认了空稿）。",
  missing:
    "草稿未保存完整：交卷时草稿未能固定为原稿（已按「草稿未保存完整」记录），不是没有草稿。",
  legacy_unverified:
    "恢复后的版本：这份草稿来自系统升级后的恢复，未验证与交卷时完全一致，暂不能作为原稿查看。",
};

/** 证据行 → 无稿原因；frozen（可渲染）返回 null */
export function resolveAbsentReason(
  evidence: NoteSubmissionEvidenceMeta | null,
): AbsentReason | null {
  if (evidence === null) return "not-collected";
  if (evidence.state === "frozen") return null;
  return evidence.state;
}

/** 查看侧的就绪元信息（来自证据头投影 + 已解析正文） */
export interface NoteOriginalReadyMeta {
  /** 生效版本（证据行 versionId；补图挂它） */
  versionId: string;
  /** 证据行记录时间（交卷事务固定时刻） */
  recordedAt: string;
  /** 正文保存次序（工作头与证据版本一致时可得；否则 null 不显示） */
  noteRevision: number | null;
  /** 正文笔迹数（空稿不显示派生图状态——imagesAggregateFor 口径） */
  strokeCount: number;
  /** 派生图查看档位（三档，见 imagesAggregateFor） */
  images: "ready" | "pending" | "failed";
}

/** 查看档位三值（ready=无提示 / pending=正文待图 / failed=缺图可重建） */
export type NoteOriginalImagesLevel = "ready" | "pending" | "failed";

/**
 * 查看侧的派生图档位映射（业务归并留本层，不进 worstImageState 原语）：
 * 空稿（0 笔）无笔迹可渲染 → ready（不提示）；有笔迹时空槽位/在途均按
 * 「正文待图」；failed/missing 归并为「缺图」（同一重建入口）。
 */
function imagesAggregateFor(
  images: NoteHeadData["images"],
  strokeCount: number,
): NoteOriginalImagesLevel {
  if (strokeCount === 0) return "ready";
  if (images.length === 0) return "pending";
  const worst = worstImageState(images);
  return worst === "missing" ? "failed" : worst;
}

/**
 * 证据头 + 正文 → 就绪元信息；证据行不是 frozen（或契约外形态缺 versionId）
 * 返回 null（调用方按数据异常处理——契约 superRefine 保证不可达的防御分支）。
 */
export function resolveReadyMeta(
  head: NoteHeadData,
  doc: NoteDoc,
): NoteOriginalReadyMeta | null {
  const evidence = head.evidence;
  if (evidence === null || evidence.state !== "frozen") return null;
  const versionId = evidence.versionId;
  if (versionId === null) return null;
  return {
    versionId,
    recordedAt: evidence.recordedAt,
    noteRevision:
      head.note !== null && head.note.currentVersionId === versionId
        ? head.note.revision
        : null,
    strokeCount: doc.ink.strokes.length,
    images: imagesAggregateFor(head.images, doc.ink.strokes.length),
  };
}

/**
 * 派生图档位刷新（重建后按新 head 重算 images 一项）：生效版本仍是指定
 * versionId 才重算；版本已变（理论不可达）返回 null，调用方维持原档位。
 */
export function refreshImagesAggregate(
  head: NoteHeadData,
  versionId: string,
  strokeCount: number,
): NoteOriginalImagesLevel | null {
  const evidence = head.evidence;
  if (
    evidence === null ||
    evidence.state !== "frozen" ||
    evidence.versionId !== versionId
  ) {
    return null;
  }
  return imagesAggregateFor(head.images, strokeCount);
}
