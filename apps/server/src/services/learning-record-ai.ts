import type {
  AiCompactionEntry,
  InkDeletedStroke,
  InkMaterialFacet,
  InkStroke,
  LearningRecord,
} from "@tutor/contract";
import {
  AI_MAX_POINTS_PER_MATERIAL,
  AI_STROKE_EPSILON_RATIO,
  type LearningRecordAiView,
  learningRecordAiViewSchema,
} from "@tutor/contract";
import type { Db } from "../db/client.ts";
import {
  getAiLearningRecord,
  learningRecordMaterialRefs,
} from "./learning-record-service.ts";

/**
 * AI 学习记录视图的压缩装配（LR-PR5，学习记录模型设计稿 §7.3；纯函数、
 * 可完整单测）：
 * - RDP 简化：ε = 坐标域宽 × AI_STROKE_EPSILON_RATIO（纸面=逻辑宽 1000、
 *   圈画=底图像素宽），保端点、只删中间点，保留点携带**原始采样的 p/t**
 *   （不插值、不改采样时刻）；
 * - 抽稀：RDP 后单材料总点数（活笔+墓碑）仍超 AI_MAX_POINTS_PER_MATERIAL
 *   → 按笔均匀抽稀（份额按点数比例、每笔下限 2 含首末），置 compacted:true。
 * 抽稀只改点密度：笔数、次序、id/startedAt/pointer 等身份字段原样保留，
 * anchors 按 stroke id 的对应关系不受影响。
 */

/** 平面点（RDP 只看 x/y；p/t 随原点保留） */
interface Point2 {
  x: number;
  y: number;
}

/** RDP 迭代简化：返回保留点下标（恒含首末；ε≤0 或 ≤2 点原样保留） */
export function rdpIndices(
  points: readonly Point2[],
  epsilon: number,
): number[] {
  const n = points.length;
  if (n <= 2 || epsilon <= 0) return points.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (range === undefined) break;
    const [start, end] = range;
    if (end - start < 2) continue;
    const ax = points[start]?.x ?? 0;
    const ay = points[start]?.y ?? 0;
    const bx = points[end]?.x ?? 0;
    const by = points[end]?.y ?? 0;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const px = points[i]?.x ?? 0;
      const py = points[i]?.y ?? 0;
      const dist =
        len === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon && maxIdx > 0) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) indices.push(i);
  return indices;
}

/** 材料坐标域宽（ε 基准）：纸面=逻辑宽 1000，圈画=底图像素宽 */
function domainWidthOf(facet: InkMaterialFacet): number {
  return facet.frame.kind === "paper"
    ? facet.frame.width
    : facet.frame.pixelWidth;
}

/**
 * 索引取元素（索引均由同一数组派生——rdp/抽稀/配平的下标恒在界内，越界即上游
 * bug）：以 as 断言收窄代替 biome 禁用的非空断言 `!`，语义等价。
 */
function elementAt<T>(xs: readonly T[], index: number): T {
  return xs[index] as T;
}

function simplifyStroke<S extends { points: InkStroke["points"] }>(
  stroke: S,
  epsilon: number,
): S {
  const indices = rdpIndices(stroke.points, epsilon);
  if (indices.length === stroke.points.length) return stroke;
  return {
    ...stroke,
    points: indices.map((i) => elementAt(stroke.points, i)),
  };
}

/** 按目标点数均匀抽稀（保首末；≤2 点或目标充足时原样） */
function decimateStroke<S extends { points: InkStroke["points"] }>(
  stroke: S,
  target: number,
): S {
  const n = stroke.points.length;
  const keepCount = Math.max(2, Math.min(n, Math.round(target)));
  if (keepCount >= n) return stroke;
  const out = [elementAt(stroke.points, 0)];
  const step = (n - 1) / (keepCount - 1);
  for (let k = 1; k < keepCount - 1; k++) {
    out.push(elementAt(stroke.points, Math.round(k * step)));
  }
  out.push(elementAt(stroke.points, n - 1));
  return { ...stroke, points: out };
}

function countPoints(strokes: readonly { points: unknown[] }[]): number {
  let sum = 0;
  for (const stroke of strokes) sum += stroke.points.length;
  return sum;
}

/** 超限时的每笔目标点数：按占比初分，再从点数最多的笔压超额（下限 2） */
function balanceTargets(counts: number[], maxTotal: number): number[] {
  const targets = counts.map((c) => Math.max(2, c));
  let excess = targets.reduce((sum, t) => sum + t, 0) - maxTotal;
  if (excess <= 0) return targets;
  const order = counts
    .map((_, i) => i)
    .sort((a, b) => elementAt(counts, b) - elementAt(counts, a));
  for (const i of order) {
    if (excess <= 0) break;
    const reducible = elementAt(targets, i) - 2;
    const cut = Math.min(reducible, excess);
    targets[i] = elementAt(targets, i) - cut;
    excess -= cut;
  }
  return targets;
}

/** 单材料压缩结果：替换 facet 的 strokes/deleted + 台账数值 */
export interface CompactedInk {
  strokes: InkStroke[];
  deleted: InkDeletedStroke[];
  originalPoints: number;
  keptPoints: number;
  compacted: boolean;
}

export function compactInkMaterial(
  facet: InkMaterialFacet,
  options?: { epsilonRatio?: number; maxPointsPerMaterial?: number },
): CompactedInk {
  const epsilonRatio = options?.epsilonRatio ?? AI_STROKE_EPSILON_RATIO;
  const maxPoints = options?.maxPointsPerMaterial ?? AI_MAX_POINTS_PER_MATERIAL;
  const epsilon = domainWidthOf(facet) * epsilonRatio;
  const strokes = facet.strokes.map((stroke) =>
    simplifyStroke(stroke, epsilon),
  );
  const deleted = facet.deleted.map((tomb) => simplifyStroke(tomb, epsilon));
  const originalPoints =
    countPoints(facet.strokes) + countPoints(facet.deleted);
  const keptPoints = countPoints(strokes) + countPoints(deleted);
  if (keptPoints <= maxPoints) {
    return { strokes, deleted, originalPoints, keptPoints, compacted: false };
  }
  // 超限：按占比初分目标，再平衡到 ≤ 预算
  const live = strokes.map((stroke) => stroke.points.length);
  const gone = deleted.map((tomb) => tomb.points.length);
  const scale = maxPoints / keptPoints;
  const rough = [...live, ...gone].map((c) =>
    Math.max(2, Math.round(c * scale)),
  );
  const targets = balanceTargets(rough, maxPoints);
  const liveTargets = targets.slice(0, strokes.length);
  const goneTargets = targets.slice(strokes.length);
  const finalStrokes = strokes.map((stroke, i) =>
    decimateStroke(stroke, liveTargets[i] ?? 2),
  );
  const finalDeleted = deleted.map((tomb, i) =>
    decimateStroke(tomb, goneTargets[i] ?? 2),
  );
  return {
    strokes: finalStrokes,
    deleted: finalDeleted,
    originalPoints,
    keptPoints: countPoints(finalStrokes) + countPoints(finalDeleted),
    compacted: true,
  };
}

/**
 * 视图装配（LR-PR5 §7.3）：压缩进视图 + 压缩台账 + 材料图片直出 URL 填充 +
 * 契约 fail-closed 校验（role 非 ai / 教师私注在 schema 层拒绝）。
 * resolveImageUrl 缺省不填——claim/dispatch 走字节内联通道，图片引用可缺席。
 */
export function learningRecordAiViewOf(
  record: LearningRecord,
  options?: {
    epsilonRatio?: number;
    maxPointsPerMaterial?: number;
    resolveImageUrl?: (
      kind: "draft" | "formal_ink" | "annotation",
      pageIndex: number,
    ) => string | undefined;
  },
): LearningRecordAiView {
  const entries: AiCompactionEntry[] = [];
  const ink = record.ink.map((facet) => {
    const compacted = compactInkMaterial(facet, options);
    entries.push({
      kind: facet.kind,
      pageIndex: 0,
      originalPoints: compacted.originalPoints,
      keptPoints: compacted.keptPoints,
      compacted: compacted.compacted,
    });
    const images = facet.images.map((image) => {
      const url =
        image.downloadUrl ??
        options?.resolveImageUrl?.(facet.kind, image.pageIndex);
      return url === undefined ? image : { ...image, downloadUrl: url };
    });
    return {
      ...facet,
      strokes: compacted.strokes,
      deleted: compacted.deleted,
      images,
    };
  });
  // 对账标识不进模型载荷：timeline detail 的 taskId 全通道剥离（dispatch
  // 载荷断言 body 不含 taskId——评审 #12249 必改①的伴随口径）
  const timeline = {
    ...record.timeline,
    entries: record.timeline.entries.map((entry) => {
      if (entry.detail?.taskId === undefined) return entry;
      const { taskId: _taskId, ...detail } = entry.detail;
      return { ...entry, detail };
    }),
  };
  return learningRecordAiViewSchema.parse({
    record: { ...record, ink, timeline },
    compaction: {
      epsilonRatio: options?.epsilonRatio ?? AI_STROKE_EPSILON_RATIO,
      maxPointsPerMaterial:
        options?.maxPointsPerMaterial ?? AI_MAX_POINTS_PER_MATERIAL,
      materials: entries,
    },
  });
}

/**
 * 任务行的 AI 视图装配（claim / dispatch / share 三视图共用）：装配失败或
 * 材料钉住漂移返回 undefined——record 是可选增强，不阻断既有链路（行为回到
 * 无 record，与 PNG 同源）。
 *
 * 评审 #12249 必改③：读端按钉住版本 fail-closed——现算 refs 与创建时钉进
 * 快照的 recordRefs 逐项比（kind/revision/hash）；不一致（含旧任务未钉住）
 * 不挂 record 并 warn 一行带 taskId。钉住审计在任务快照 recordRefs。
 */
export function learningRecordAiViewForTask(
  db: Db,
  dataDir: string,
  task: {
    id: string;
    attemptId: string;
    questionId: string;
    studentId: string;
    contextSnapshotJson: string;
  },
  options?: {
    resolveImageUrl?: (
      kind: "draft" | "formal_ink" | "annotation",
      pageIndex: number,
    ) => string | undefined;
  },
): LearningRecordAiView | undefined {
  try {
    const pinned = pinnedRecordRefsOf(task.contextSnapshotJson);
    const current = learningRecordMaterialRefs(
      db,
      task.attemptId,
      task.questionId,
    );
    if (JSON.stringify(pinned) !== JSON.stringify(current)) {
      console.warn(
        `[lr5] refs_drift taskId=${task.id} pinned=${JSON.stringify(pinned)} current=${JSON.stringify(current)}`,
      );
      return undefined;
    }
    const record = getAiLearningRecord(
      db,
      dataDir,
      task.studentId,
      task.attemptId,
      task.questionId,
    );
    return learningRecordAiViewOf(record, options);
  } catch (error) {
    console.warn(`[lr5] record_assembly_failed taskId=${task.id}`, error);
    return undefined;
  }
}

/** 从任务快照 JSON 提取 recordRefs（未钉住/损坏 → null，比对恒不相等） */
function pinnedRecordRefsOf(contextSnapshotJson: string): unknown {
  try {
    const parsed = JSON.parse(contextSnapshotJson) as {
      recordRefs?: unknown;
    };
    return Array.isArray(parsed.recordRefs) ? parsed.recordRefs : null;
  } catch {
    return null;
  }
}

/** 学习记录段（claim/dispatch 共用；追加进数据段尾部） */
export function learningRecordSectionMd(view: LearningRecordAiView): string {
  return `\n\n## 学习记录（结构化数据）\n\n以下 JSON 是本题学习过程的结构化记录（点序列已 RDP 压缩；compacted=true 表示超限按笔抽稀），与上方书写材料互为印证：\n\n\`\`\`json\n${JSON.stringify(view)}\n\`\`\``;
}

/**
 * 分享通道投影（评审 #12249 必改②）：按键定点隐去内部标识——identity 的
 * responses 行 id 置占位、timeline detail 去 taskId 键；笔画 id / anchors
 * 不动（锚语义：afterStrokeId 与 strokeIds 都要可回指）。投影后契约 parse
 * fail-closed——不过就抛，调用方整段省略，不发坏记录。
 */
export function projectShareRecord(
  view: LearningRecordAiView,
): LearningRecordAiView {
  return learningRecordAiViewSchema.parse({
    ...view,
    record: {
      ...view.record,
      identity: {
        ...view.record.identity,
        questionRevisionId: "（内部标识已隐藏）",
      },
      timeline: {
        ...view.record.timeline,
        entries: view.record.timeline.entries.map((entry) => {
          if (entry.detail?.taskId === undefined) return entry;
          const { taskId: _taskId, ...detail } = entry.detail;
          return { ...entry, detail };
        }),
      },
    },
  });
}
