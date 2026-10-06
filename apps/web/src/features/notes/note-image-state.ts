/**
 * 派生图状态聚合原语（T6R.11 复审收敛）：note 域三处消费方
 * （note-store 的 deriveImagesState、use-note-head 的补图触发判定、
 * NoteOriginalView 的查看档位）共用的「最差行状态」单一实现。
 *
 * 纯数组语义：severity 排序 failed > pending > missing > ready（与
 * note-store 既有口径一致），空数组 → "ready"（无坏行）——**各消费方的
 * 空数组档位映射留在各自侧**（note-store 把空视为「图片待生成」pending；
 * 原稿查看把空稿〔0 笔〕短路为 ready），不在本原语内做业务归并。
 */
import type { NoteImageMeta, NoteImageState } from "@tutor/contract";

/** 严重度（越大越坏）；顺序即 note-store 既有判定次序 */
const RANK: Record<NoteImageState, number> = {
  ready: 0,
  missing: 1,
  pending: 2,
  failed: 3,
};

/** 取派生图行集合的最差状态（空数组 → "ready"） */
export function worstImageState(
  images: readonly NoteImageMeta[],
): NoteImageState {
  let worst: NoteImageState = "ready";
  for (const img of images) {
    if (RANK[img.state] > RANK[worst]) worst = img.state;
  }
  return worst;
}

/**
 * 是否存在损坏行（failed/missing 任一）：补图触发与查看档位「缺图」判定的
 * **存在性谓词**——与排序无关（[missing,pending] 含损坏行即缺图，不能因
 * pending 排序更高而漏判）。排序场景（note-store 档位）才用 worstImageState。
 */
export function hasBrokenRow(images: readonly NoteImageMeta[]): boolean {
  return images.some(
    (img) => img.state === "failed" || img.state === "missing",
  );
}
