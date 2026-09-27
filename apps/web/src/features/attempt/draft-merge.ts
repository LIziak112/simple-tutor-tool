import type { InkDoc, StudentAnswer } from "@tutor/contract";
import type { AttemptDraftRecord } from "./draft-store";

/**
 * 草稿合并的纯函数集（T2.9）：稳定内容摘要（去重依据）、未同步题计算、
 * 本地/服务端笔迹的合并策略。无副作用、无 React，便于单测。
 *
 * 设计口径（任务要点「同步去重」与「合并策略」）：
 * - 摘要 = 递归按键名排序的稳定 JSON 串，用于「相同内容不重复 PUT」；
 * - 服务端 answers 无逐条时间戳（T2.6 设计），答案合并只能按内容比较：
 *   并集 + 冲突以本地为准（本地是学生最后一次操作的设备），局限见任务报告
 *   「待决问题」——服务端 attempt 无 updatedAt，无法判断哪边更新；
 * - 笔迹有 InkDoc.updatedAt（客户端书写时钟，epoch 毫秒）可比：新者胜，
 *   平手比笔画数，再平取本地。
 */

/** 递归按键名排序的稳定序列化（对象键序不影响摘要；数组保序） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** 内容摘要（答案/笔迹的去重指纹） */
export function digestOf(value: unknown): string {
  return stableStringify(value);
}

/** 本地有、但尚未成功同步到服务端的答案题号列表 */
export function unsyncedAnswerIds(record: AttemptDraftRecord): string[] {
  return Object.keys(record.answers).filter(
    (questionId) =>
      record.answerDigests[questionId] !== digestOf(record.answers[questionId]),
  );
}

/** 本地有、但尚未成功同步到服务端的笔迹题号列表（供测试与诊断） */
export function unsyncedInkIds(record: AttemptDraftRecord): string[] {
  return Object.keys(record.inks).filter(
    (questionId) =>
      record.inkDigests[questionId] !== digestOf(record.inks[questionId]),
  );
}

/**
 * 进入答题页时的答案合并：服务端草稿 ∪ 本地草稿，逐题冲突以本地为准。
 * 本地为 null（本机第一次作答）时直接采纳服务端。
 * 返回合并结果与「合并后仍需同步到服务端的题」（本地内容与服务端不同）。
 */
export function mergeAnswers(
  local: Record<string, StudentAnswer> | null,
  server: Record<string, StudentAnswer>,
): {
  merged: Record<string, StudentAnswer>;
  /** 合并后与服务端内容不一致、需要 PUT 补传的题号（本地胜出或本地独有） */
  needsSync: string[];
} {
  if (local === null) return { merged: { ...server }, needsSync: [] };
  const merged: Record<string, StudentAnswer> = { ...server, ...local };
  const needsSync = Object.keys(local).filter(
    (questionId) =>
      digestOf(local[questionId]) !== digestOf(server[questionId]),
  );
  return { merged, needsSync };
}

/** 笔迹的笔画数（atrament=strokes.length；excalidraw=elements.length） */
export function inkStrokeCountOf(doc: InkDoc): number {
  return doc.engine === "atrament"
    ? doc.data.strokes.length
    : doc.data.scene.elements.length;
}

/** 笔迹合并结果：最终采用的文档与来源（none=两边都空） */
export interface InkMergeResult {
  doc: InkDoc | null;
  source: "local" | "server" | "none";
  /** 两边内容是否不一致（source=local 且 differs=true 时需要补传服务端） */
  differs: boolean;
}

/**
 * 本地/服务端笔迹合并（进入答题页时逐题调用）：
 * - 一边为空 → 取另一边；
 * - 内容一致 → 取本地（无差异，无需补传）；
 * - 内容不同 → updatedAt（客户端最后书写时钟）新者胜；平手比笔画数；再平取本地。
 * 局限：跨设备时钟偏移可能误判，见任务报告「待决问题」。
 */
export function mergeInkDocs(
  local: InkDoc | null,
  server: InkDoc | null,
): InkMergeResult {
  if (local === null && server === null) {
    return { doc: null, source: "none", differs: false };
  }
  if (local === null) return { doc: server, source: "server", differs: false };
  if (server === null) return { doc: local, source: "local", differs: true };
  const differs = digestOf(local) !== digestOf(server);
  if (!differs) return { doc: local, source: "local", differs: false };
  if (local.updatedAt > server.updatedAt) {
    return { doc: local, source: "local", differs: true };
  }
  if (local.updatedAt < server.updatedAt) {
    return { doc: server, source: "server", differs: false };
  }
  // updatedAt 相同（极少）：笔画多者视为更新（清空重写场景笔画会变少，取多的更保守）
  const localStrokes = inkStrokeCountOf(local);
  const serverStrokes = inkStrokeCountOf(server);
  return localStrokes >= serverStrokes
    ? { doc: local, source: "local", differs: true }
    : { doc: server, source: "server", differs: false };
}
