import { inkRenderingSchema } from "@tutor/contract";
/**
 * 笔迹回放的纯数据层（T3.3，D12）。
 *
 * 职责划分（canvas 真实渲染 jsdom 不可测，故逻辑全部纯函数化）：
 * - parseInkReplayData：把 fetchTeacherInkStrokesApi 返回的 unknown 收窄成回放模型
 *   （宽松结构校验——接口层刻意不做 Zod：矢量接口可能落盘早期/异常数据，
 *   坏数据返回 null，由组件降级显示 PNG）；
 * - frameAt(data, tMs)：时刻 → 应显示的笔画状态（组件只负责画上 canvas 与调度）；
 * - advancePlayhead / formatReplayTime：播放推进与时间展示。
 *
 * 时间轴口径（重要，D12）：
 * - atrament 点的 t 只记录「相对本笔起点」的毫秒（契约 inkStrokePointSchema 注释
 *   与 atrament-adapter 的 liveStartStamp），**笔与笔之间的真实停顿没有记录**——
 *   回放时间轴按「上一笔结束 + 固定间隙」拼接（REPLAY_INTER_STROKE_GAP_MS 近似），
 *   笔内时间戳精确到采样点；
 * - 缺时间戳的旧数据（t 非有限正数）退化为匀速：每点固定 REPLAY_UNIFORM_POINT_MS；
 * - excalidraw 元素无时间戳：按元素顺序匀速近似——freedraw 按点数加权
 *   （每点 REPLAY_UNIFORM_POINT_MS，保底 REPLAY_ELEMENT_MIN_MS），其余元素固定
 *   REPLAY_ELEMENT_MIN_MS，逐个整体出现（无逐点重演，库原生数据无点级时刻）；
 * - 总时长下限（实测跟进：回放可读性下限）：正时长不足 REPLAY_MIN_DURATION_MS
 *   时按比例拉伸各段时间戳（相对节奏与先后顺序不变）；0 时长（无笔画/空元素）
 *   不拉伸——保持「即时完整显示」的原语义。
 */
import type { InkStroke, InkStrokePoint } from "../engine/index.ts";

/** 相邻两笔之间的停顿时长近似（ms）。真实停顿未记录（t 相对本笔起点），取固定值 */
export const REPLAY_INTER_STROKE_GAP_MS = 160;

/** 真实停顿显示上限（ms，设计稿 §7.1）：笔间真实间隙超此值时时间轴压缩到
 * 上限，实际时长记进 model.pauses（UI 在该处画「停顿 N 秒」标记） */
export const REPLAY_PAUSE_CAP_MS = 5000;

/** 缺时间戳数据退化为匀速时，每个点的固定时长（ms） */
export const REPLAY_UNIFORM_POINT_MS = 12;

/** excalidraw 每个元素的最短占位时长（ms；freedraw 按点数加权可更长） */
export const REPLAY_ELEMENT_MIN_MS = 240;

/**
 * 回放总时长下限（ms）。实测跟进：回放可读性下限——快速书写（如点划）总时长
 * 可能仅 0.3s 一闪而过，不足此值的时间轴等比拉伸到下限再交给回放（见
 * stretchToMinDuration）。
 */
export const REPLAY_MIN_DURATION_MS = 2000;

/** 倍速档位（只影响调度快慢，不影响 frameAt 的画面） */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** atrament 回放画布的内容逻辑高度边界（纵横比由内容 maxY 近似，见 contentHeight） */
const CONTENT_MIN_HEIGHT = 220;
const CONTENT_MAX_HEIGHT = 3000;
/** 内容上下留白（逻辑单位） */
const CONTENT_PADDING = 40;
/** 无任何点时的缺省内容高度（逻辑单位） */
const EMPTY_CONTENT_HEIGHT = 400;

/** atrament 回放模型：strokes 与 slots 一一对应 */
export interface AtramentReplayModel {
  engine: "atrament";
  /** 笔画（顺序 = 书写顺序；点的 t 已归一为本笔内非递减时刻） */
  strokes: InkStroke[];
  /** 每笔时间轴：全局起点 + 每点相对本笔起点的毫秒（非递减，首点恒 0） */
  slots: Array<{ startMs: number; pointTimesMs: number[] }>;
  /** 总时长（ms；无笔画为 0） */
  durationMs: number;
  /** 内容逻辑高度（maxY + 留白，用于画布纵横比；无点给缺省值） */
  contentHeight: number;
  /** 时间轴口径（LR-PR4）：real=全笔有 startedAt（真实间隙）；approx=固定拼接 */
  timing: "real" | "approx";
  /** real 口径下的长停顿标记（间隙超 REPLAY_PAUSE_CAP_MS 压缩后记录实际时长） */
  pauses: Array<{ atMs: number; realMs: number }>;
  /** 被删笔画时间轴（教师「看擦改」开关用）：绘制自 startedAt 起、deletedAt 消失 */
  deletedSlots: Array<{
    stroke: InkStroke;
    startMs: number;
    deletedAtMs: number;
    pointTimesMs: number[];
  }>;
}

/** excalidraw 回放模型：elements 与 slots 一一对应 */
export interface ExcalidrawReplayModel {
  engine: "excalidraw";
  /** 库原生场景元素（顺序 = 生成顺序） */
  elements: Record<string, unknown>[];
  /** 每元素时间轴（全局起止；元素在 startMs 时刻整体出现） */
  slots: Array<{ startMs: number; endMs: number }>;
  durationMs: number;
}

export type InkReplayModel = AtramentReplayModel | ExcalidrawReplayModel;

/** frameAt 的产物：某时刻应显示的笔画状态（组件照此绘制） */
export type InkReplayFrame =
  | {
      engine: "atrament";
      /** 每笔可见点数（0=尚未开始；进行中笔画为已走过的点数） */
      visiblePoints: number[];
    }
  | {
      engine: "excalidraw";
      /** 已出现的元素个数（元素整体出现，无进行中形态） */
      visibleElements: number;
    };

/** 未知值 → 有限数字判别 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 未知值 → 非空对象判别（排除数组与 null） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析中的中间形态：笔画 + 每点原始时间戳（null=缺失/非法）+ 落笔绝对时刻 */
interface RawStroke {
  stroke: InkStroke;
  rawTimes: Array<number | null>;
  startedAt: number | null;
}

/** 解析中的墓碑中间形态（宽松：坏条目跳过，不拖垮整份回放） */
interface RawDeletedStroke {
  stroke: InkStroke;
  rawTimes: Array<number | null>;
  startedAt: number | null;
  deletedAt: number | null;
}

/**
 * 单笔宽松解析（atrament 活笔画与墓碑共用）：points 结构坏返回 null；
 * tool/color/weight/p/t 缺失或非法给缺省值；startedAt 正整数才采集。
 */
function parseSingleStroke(item: Record<string, unknown>): {
  stroke: InkStroke;
  rawTimes: Array<number | null>;
  startedAt: number | null;
} | null {
  if (!Array.isArray(item.points)) return null;
  const points: InkStrokePoint[] = [];
  const rawTimes: Array<number | null> = [];
  for (const p of item.points) {
    if (!isPlainObject(p)) return null;
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return null;
    const pressure = isFiniteNumber(p.p) ? Math.min(1, Math.max(0, p.p)) : 0.5;
    const t = isFiniteNumber(p.t) && p.t >= 0 ? p.t : null;
    // t 先占位 0，buildAtramentModel 归一后回写（保证模型内 InkStroke 契约合法）
    points.push({ x: p.x, y: p.y, p: pressure, t: 0 });
    rawTimes.push(t);
  }
  return {
    stroke: {
      ...(item.rendering && inkRenderingSchema.safeParse(item.rendering).success
        ? { rendering: inkRenderingSchema.parse(item.rendering) }
        : {}),
      tool: item.tool === "highlighter" ? "highlighter" : "pen",
      color:
        typeof item.color === "string" && item.color.length > 0
          ? item.color
          : "#1f2328",
      weight: isFiniteNumber(item.weight) && item.weight > 0 ? item.weight : 4,
      // LR-1/LR-2 字段透传（宽松校验）：id 供锚点/时间线引用；startedAt 供真实停顿
      ...(typeof item.id === "string" &&
      item.id.length >= 8 &&
      item.id.length <= 40 &&
      /^[0-9A-Za-z_-]+$/.test(item.id)
        ? { id: item.id }
        : {}),
      ...(isFiniteNumber(item.startedAt) && item.startedAt > 0
        ? { startedAt: item.startedAt }
        : {}),
      ...(item.pointer === "pen" ||
      item.pointer === "touch" ||
      item.pointer === "mouse"
        ? { pointer: item.pointer }
        : {}),
      points,
    },
    rawTimes,
    startedAt:
      isFiniteNumber(item.startedAt) && item.startedAt > 0
        ? item.startedAt
        : null,
  };
}

/** 墓碑宽松解析：几何沿用单笔解析；startedAt/deletedAt 至少其一有效才收 */
function parseAtramentDeleted(raw: unknown): RawDeletedStroke[] {
  if (!Array.isArray(raw)) return [];
  const out: RawDeletedStroke[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const parsed = parseSingleStroke(item);
    if (parsed === null) continue;
    const deletedAt =
      isFiniteNumber(item.deletedAt) && item.deletedAt > 0
        ? item.deletedAt
        : null;
    if (parsed.startedAt === null && deletedAt === null) continue;
    out.push({
      stroke: parsed.stroke,
      rawTimes: parsed.rawTimes,
      startedAt: parsed.startedAt,
      deletedAt,
    });
  }
  return out;
}

/**
 * 宽松解析 atrament strokes 数组。
 * 结构坏（非数组 / 笔画缺 points / 点缺有限 x、y）→ 整体 null（走降级）；
 * tool/color/weight/p/t 缺失或非法给缺省值（不影响绘制主体）。
 */
function parseAtramentStrokes(raw: unknown): RawStroke[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawStroke[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return null;
    const parsed = parseSingleStroke(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * 每点原始时间戳 → 本笔内非递减时刻（首点恒 0）：
 * - 全部缺失 → 匀速退化（i × REPLAY_UNIFORM_POINT_MS）；
 * - 部分缺失 → 以首个有效时间戳为原点，缺失点沿用前一刻（同时出现），
 *   并夹逼为非递减（脏数据的倒退时间不回退画面）。
 */
function normalizePointTimes(rawTimes: Array<number | null>): number[] {
  const firstValid = rawTimes.findIndex((t) => t !== null);
  if (firstValid === -1) {
    return rawTimes.map((_, i) => i * REPLAY_UNIFORM_POINT_MS);
  }
  const base = rawTimes[firstValid] ?? 0;
  let prev = 0;
  return rawTimes.map((t) => {
    const next = t === null ? prev : Math.max(prev, Math.max(0, t - base));
    prev = next;
    return next;
  });
}

/** 由解析结果组装 atrament 回放模型（双口径时间轴 + 纵横比近似；LR-PR4） */
function buildAtramentModel(
  raws: RawStroke[],
  deleted: RawDeletedStroke[],
): AtramentReplayModel {
  const normalized = raws.map((r) => ({
    stroke: r.stroke,
    pointTimesMs: normalizePointTimes(r.rawTimes),
    startedAt: r.startedAt,
  }));
  // 归一结果回写点的 t（模型内 InkStroke 契约合法且自洽）；顺带取内容高
  let maxY = 0;
  let hasPoint = false;
  for (const item of normalized) {
    for (let i = 0; i < item.stroke.points.length; i++) {
      const point = item.stroke.points[i];
      const t = item.pointTimesMs[i];
      if (point && t !== undefined) point.t = t;
      if (point) {
        maxY = Math.max(maxY, point.y);
        hasPoint = true;
      }
    }
  }
  // 评审 #11771 顺手项：maxY 并入墓碑点——全擦光稿的墓碑不被裁掉
  for (const tomb of deleted) {
    for (const point of tomb.stroke.points) {
      maxY = Math.max(maxY, point.y);
      hasPoint = true;
    }
  }
  const contentHeight = hasPoint
    ? Math.min(
        CONTENT_MAX_HEIGHT,
        Math.max(CONTENT_MIN_HEIGHT, maxY + CONTENT_PADDING * 2),
      )
    : EMPTY_CONTENT_HEIGHT;

  // 时间轴口径（LR-PR4，设计稿 §7.1）：全部笔画带 startedAt → 真实间隙
  //（超 REPLAY_PAUSE_CAP_MS 压缩 + 记「停顿 N 秒」标记）；任一缺失 → 旧口径
  //（固定 160ms 拼接）。墓碑无真实时刻（approx 口径或自身缺 startedAt）不显示——如实。
  const allTimed =
    // 评审 #11768 顺手新增：「全部擦光」的稿（strokes 空、墓碑全带时刻）也走
    // real——看擦改的另一主场景；门槛 = 活笔全带时刻且 strokes∪deleted 非空
    normalized.every((item) => item.startedAt !== null) &&
    normalized.length + deleted.length > 0;
  const slots: AtramentReplayModel["slots"] = [];
  const pauses: AtramentReplayModel["pauses"] = [];
  const deletedSlots: AtramentReplayModel["deletedSlots"] = [];
  let durationMs = 0;
  if (allTimed) {
    // 防御性排序（评审 #11750 顺手项）：同步为整文档 CAS 不乱序，排序保
    // slots/strokes/时间轴三方对齐一致（approx 口径不排序——缺 startedAt
    // 的旧稿按数组序，排序键会全塌到 0 互相颠倒）
    normalized.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const tombsNormalized = deleted.map((tomb) => {
      // 最后一个非空原始 t（书写进度终点；缺失塌 0 的场景由 ?? 0 兜底）
      const lastRawT = [...tomb.rawTimes]
        .reverse()
        .find((t): t is number => typeof t === "number" && t >= 0);
      const pointTimesMs = normalizePointTimes(tomb.rawTimes);
      return {
        stroke: tomb.stroke,
        startedAt: tomb.startedAt,
        deletedAt: tomb.deletedAt,
        pointTimesMs,
        // 评审 #11750 必改②-C：书写终点 = startedAt + 最后一个非空原始 t
        //（normalizePointTimes 会把单点时刻塌成 0——这里用原始值，三态都对）
        writingEnd:
          tomb.startedAt !== null ? tomb.startedAt + (lastRawT ?? 0) : null,
      };
    });
    // t0 = min(strokes∪deleted 的 startedAt)（评审 #11768 必改②-B：墓碑早于
    // 首笔活笔的「先写→全擦→重写」主场景，rel 不得为负）
    const startsSeen: number[] = [];
    for (const item of normalized) {
      if (item.startedAt !== null) startsSeen.push(item.startedAt);
    }
    for (const tomb of tombsNormalized) {
      if (tomb.startedAt !== null) startsSeen.push(tomb.startedAt);
    }
    if (startsSeen.length === 0) {
      return {
        engine: "atrament",
        strokes: [],
        slots: [],
        durationMs: 0,
        contentHeight: EMPTY_CONTENT_HEIGHT,
        timing: "approx",
        pauses: [],
        deletedSlots: [],
      };
    }
    const t0 = Math.min(...startsSeen);
    // moments = 活笔起点/终点 + 墓碑起点/墓碑终点（startedAt + 末点 t，②-C：
    // 墓碑书写时段进 moments，删除时刻才不会被当空闲压缩）
    const realMoments: number[] = [];
    for (const item of normalized) {
      const start = item.startedAt ?? 0;
      realMoments.push(start, start + (item.pointTimesMs.at(-1) ?? 0));
    }
    for (const tomb of tombsNormalized) {
      if (tomb.startedAt === null || tomb.writingEnd === null) continue;
      realMoments.push(tomb.startedAt, tomb.writingEnd);
      // 评审 #11750 必改②-C：删除时刻也是时刻——擦在末笔之后要播得到消失。
      // 评审 #11771 顺手项另一半：跨设备时钟偏差可能让 deletedAt 早于书写
      // 终点——与 deletedSlots 同一钳制 max(deletedAt, writingEnd)；钳后等于
      // writingEnd 时由下方 Set 去重，不产生多余分段。
      if (tomb.deletedAt !== null) {
        realMoments.push(Math.max(tomb.deletedAt, tomb.writingEnd));
      }
    }
    const moments = [...new Set(realMoments)].sort((a, b) => a - b);
    // segCap（评审 #11768 处方）：段落在任一笔（活或墓碑）的书写区间内 →
    // cap = gap（书写不压缩不标记）；否则空闲 → cap = min(gap, 5000)。
    // shift 累加与 compress() 用同一张 segCap 表。
    const segCaps: number[] = [];
    for (let i = 0; i + 1 < moments.length; i++) {
      const from = moments[i] ?? 0;
      const to = moments[i + 1] ?? from;
      const gap = to - from;
      let writing = false;
      const overlaps = (wStart: number, wEnd: number): boolean =>
        from < wEnd && to > wStart;
      for (const item of normalized) {
        if (item.startedAt === null) continue;
        if (
          overlaps(
            item.startedAt,
            item.startedAt + (item.pointTimesMs.at(-1) ?? 0),
          )
        ) {
          writing = true;
          break;
        }
      }
      if (!writing) {
        // 墓碑的书写区间 = [startedAt, startedAt + 原始末点 t]（处方 §11768：
        // 段落在任一笔的书写区间内才 cap=gap；删除后的空闲段照常压缩）
        for (const tomb of tombsNormalized) {
          if (tomb.startedAt === null || tomb.writingEnd === null) continue;
          if (overlaps(tomb.startedAt, tomb.writingEnd)) {
            writing = true;
            break;
          }
        }
      }
      segCaps.push(writing ? gap : Math.min(gap, REPLAY_PAUSE_CAP_MS));
    }
    const momentRel: number[] = [];
    const mapped: number[] = [];
    for (let i = 0; i < moments.length; i++) {
      const rel = (moments[i] ?? 0) - t0;
      // 进入时刻 i 的段 = [moments[i-1], moments[i]]，cap = segCaps[i-1]
      const cap =
        i > 0 && i - 1 < segCaps.length
          ? (segCaps[i - 1] ?? REPLAY_PAUSE_CAP_MS)
          : REPLAY_PAUSE_CAP_MS;
      let thisMapped: number;
      if (i > 0) {
        const prevRel = momentRel[i - 1] ?? 0;
        const prevMapped = mapped[i - 1] ?? 0;
        const gap = rel - prevRel;
        thisMapped = prevMapped + Math.min(gap, cap);
        if (gap > cap) {
          // 空闲段压缩：显示封顶为 cap，实际时长进「停顿」标记（§7.1）
          pauses.push({ atMs: thisMapped, realMs: gap });
        }
      } else {
        thisMapped = Math.max(0, rel);
      }
      momentRel.push(rel);
      mapped.push(thisMapped);
    }
    /** 分段映射 compress：与 segCap 表同式（段内 1:1、边界按 cap 跳变） */
    const compress = (realAbs: number): number => {
      const rel = Math.max(0, realAbs - t0);
      for (let i = 0; i < momentRel.length; i++) {
        const segStart = momentRel[i] ?? 0;
        if (i + 1 < momentRel.length && rel > (momentRel[i + 1] ?? 0)) continue;
        const cap =
          i < segCaps.length
            ? (segCaps[i] ?? REPLAY_PAUSE_CAP_MS)
            : REPLAY_PAUSE_CAP_MS;
        return (mapped[i] ?? 0) + Math.min(rel - segStart, cap);
      }
      return mapped[mapped.length - 1] ?? 0;
    };
    for (const item of normalized) {
      slots.push({
        startMs: compress(item.startedAt ?? t0),
        pointTimesMs: item.pointTimesMs,
      });
    }
    // 墓碑时间轴（real 口径）：同一 compress——停顿前写并擦掉的墓碑不再归零
    for (const tomb of tombsNormalized) {
      if (tomb.startedAt === null || tomb.deletedAt === null) continue;
      // 评审 #11771 顺手项：跨设备时钟偏差可能让 deletedAt 早于书写终点——
      // 钳到 max(deletedAt, writingEnd)，时间轴不右移
      const clampedDeletedAt = Math.max(
        tomb.deletedAt,
        tomb.writingEnd ?? tomb.deletedAt,
      );
      deletedSlots.push({
        stroke: tomb.stroke,
        pointTimesMs: tomb.pointTimesMs,
        startMs: compress(tomb.startedAt),
        deletedAtMs: compress(clampedDeletedAt),
      });
    }
    durationMs = mapped.length > 0 ? (mapped[mapped.length - 1] ?? 0) : 0;
  } else {
    let cursor = 0;
    for (const item of normalized) {
      const pointTimesMs = item.pointTimesMs;
      slots.push({ startMs: cursor, pointTimesMs });
      const lastTime = pointTimesMs[pointTimesMs.length - 1] ?? 0;
      // 只有含点的笔画才推进总时长（空笔画不占进度条）
      if (pointTimesMs.length > 0) durationMs = cursor + lastTime;
      cursor = cursor + lastTime + REPLAY_INTER_STROKE_GAP_MS;
    }
  }
  return {
    engine: "atrament",
    strokes: normalized.map((item) => item.stroke),
    slots,
    durationMs,
    contentHeight,
    timing: allTimed ? "real" : "approx",
    pauses,
    deletedSlots,
  };
}

/**
 * excalidraw 元素时长（匀速近似口径）：
 * freedraw 按点数加权（每点 REPLAY_UNIFORM_POINT_MS），其余元素固定最短时长。
 */
function elementDurationMs(el: Record<string, unknown>): number {
  if (el.type === "freedraw" && Array.isArray(el.points)) {
    return Math.max(
      REPLAY_ELEMENT_MIN_MS,
      el.points.length * REPLAY_UNIFORM_POINT_MS,
    );
  }
  return REPLAY_ELEMENT_MIN_MS;
}

/** 宽松解析 excalidraw data.scene.elements（须为对象数组，内部交给库 restore 清洗） */
function parseExcalidrawElements(
  raw: unknown,
): Record<string, unknown>[] | null {
  if (!isPlainObject(raw)) return null;
  const scene = raw.scene;
  if (!isPlainObject(scene)) return null;
  if (!Array.isArray(scene.elements)) return null;
  const out: Record<string, unknown>[] = [];
  for (const el of scene.elements) {
    if (!isPlainObject(el)) return null;
    out.push(el);
  }
  return out;
}

/**
 * 总时长下限拉伸（实测跟进：回放可读性下限）：0 < durationMs < 下限时，全部
 * 时间戳（slot 起点、点时刻 / 元素起止，含回写到 InkStroke 的 t）按下限与原
 * 时长之比等比缩放，相对节奏与先后顺序不变；0 时长不拉伸。总时长取下限与
 * 拉伸后实际末点的较大者——浮点缩放可能让末点略微过冲，取 max 保证「进度
 * 到尾 = 全部可见」不变式（≥ 下限，误差 < 1 纳秒，展示无感）。
 */
function stretchToMinDuration(model: InkReplayModel): void {
  if (model.durationMs <= 0 || model.durationMs >= REPLAY_MIN_DURATION_MS) {
    return;
  }
  const scale = REPLAY_MIN_DURATION_MS / model.durationMs;
  /** 拉伸后的实际末点时刻 */
  let end = 0;
  if (model.engine === "atrament") {
    // strokes 与 slots 一一对应（见 AtramentReplayModel），同步缩放保自洽
    for (const [index, slot] of model.slots.entries()) {
      slot.startMs *= scale;
      slot.pointTimesMs = slot.pointTimesMs.map((t) => t * scale);
      const stroke = model.strokes[index];
      if (stroke) {
        for (const point of stroke.points) point.t *= scale;
      }
      const last = slot.pointTimesMs[slot.pointTimesMs.length - 1];
      if (last !== undefined) end = Math.max(end, slot.startMs + last);
    }
    // 评审 #11750 必改②b：停顿标记与墓碑时间轴随同一比例缩放
    for (const pause of model.pauses) pause.atMs *= scale;
    for (const tomb of model.deletedSlots) {
      tomb.startMs *= scale;
      tomb.deletedAtMs *= scale;
      tomb.pointTimesMs = tomb.pointTimesMs.map((t) => t * scale);
    }
  } else {
    for (const slot of model.slots) {
      slot.startMs *= scale;
      slot.endMs *= scale;
      end = Math.max(end, slot.endMs);
    }
  }
  model.durationMs = Math.max(REPLAY_MIN_DURATION_MS, end);
}

/**
 * 把矢量接口返回的 unknown 收窄成回放模型（宽松校验，见文件头）。
 * 任何结构不符（未知 engine / version 不支持 / 缺 strokes / elements 非数组…）
 * 返回 null，调用方走「无回放数据」降级。
 */
export function parseInkReplayData(raw: unknown): InkReplayModel | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== 1) return null;
  if (raw.engine === "atrament") {
    if (!isPlainObject(raw.data)) return null;
    const parsed = parseAtramentStrokes(raw.data.strokes);
    if (parsed === null) return null;
    const model = buildAtramentModel(
      parsed,
      parseAtramentDeleted(raw.data.deleted),
    );
    stretchToMinDuration(model);
    return model;
  }
  if (raw.engine === "excalidraw") {
    if (!isPlainObject(raw.data)) return null;
    const elements = parseExcalidrawElements(raw.data);
    if (elements === null) return null;
    const slots: ExcalidrawReplayModel["slots"] = [];
    let cursor = 0;
    for (const el of elements) {
      const dur = elementDurationMs(el);
      slots.push({ startMs: cursor, endMs: cursor + dur });
      cursor += dur;
    }
    const model: ExcalidrawReplayModel = {
      engine: "excalidraw",
      elements,
      slots,
      durationMs: cursor,
    };
    stretchToMinDuration(model);
    return model;
  }
  return null;
}

/**
 * 时刻 → 应显示的笔画状态（纯函数；倍速与调度不影响本函数结果）。
 * tMs 越界按 [0, durationMs] 夹逼；无笔画/无元素返回全空帧。
 */
export function frameAt(data: InkReplayModel, tMs: number): InkReplayFrame {
  const t = Math.min(Math.max(tMs, 0), data.durationMs);
  if (data.engine === "atrament") {
    const visiblePoints: number[] = [];
    for (const slot of data.slots) {
      if (t < slot.startMs || slot.pointTimesMs.length === 0) {
        visiblePoints.push(0);
        continue;
      }
      const rel = t - slot.startMs;
      // pointTimesMs 非递减：顺序数出 ≤ rel 的点即停（题级数据量小，无需二分）
      let count = 0;
      for (const pt of slot.pointTimesMs) {
        if (pt <= rel) count++;
        else break;
      }
      visiblePoints.push(count);
    }
    return { engine: "atrament", visiblePoints };
  }
  let visibleElements = 0;
  for (const slot of data.slots) {
    if (slot.startMs <= t) visibleElements++;
    else break;
  }
  return { engine: "excalidraw", visibleElements };
}

/** 播放推进（纯函数）：真实流逝时长 × 倍速 → 下一时刻；到尾即夹逼并标记 ended */
export function advancePlayhead(
  prevMs: number,
  elapsedMs: number,
  speed: number,
  durationMs: number,
): { timeMs: number; ended: boolean } {
  const elapsed = Math.max(0, elapsedMs);
  const timeMs = Math.min(prevMs + elapsed * speed, durationMs);
  return { timeMs, ended: timeMs >= durationMs };
}

/** 回放时间展示：<1 分钟显示 0.1 秒精度，超过按「x 分 yy 秒」 */
export function formatReplayTime(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return seconds === 0
    ? `${minutes} 分`
    : `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}
