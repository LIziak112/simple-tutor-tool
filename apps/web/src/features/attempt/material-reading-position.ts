/**
 * 材料阅读位置的会话内保留（QM-08 细项 3）：「查看材料」跳转离开后再回来
 * 不丢已读位置。纯内存 Map（键 = attemptId|groupId）——不落 localStorage：
 * 材料内容不进入持久化存储，会话结束即弃（与题级阅读位置
 * use-reading-position 的持久化语义不同：那是整卷作答续读，这是组内往返）。
 */
const offsets = new Map<string, number>();

/** 读取某组材料区域的已读偏移（px；0 = 未记录/未读） */
export function materialReadingOffsetOf(key: string): number {
  return offsets.get(key) ?? 0;
}

/** 记录偏移（滚动监听高频调用：同值直接跳过写 Map） */
export function noteMaterialReadingOffset(key: string, offset: number): void {
  if (!Number.isFinite(offset) || offset < 0) return;
  if (offsets.get(key) === offset) return;
  offsets.set(key, offset);
}
