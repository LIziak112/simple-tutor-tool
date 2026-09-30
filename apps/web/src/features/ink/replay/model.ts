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
 *   REPLAY_ELEMENT_MIN_MS，逐个整体出现（无逐点重演，库原生数据无点级时刻）。
 */
import type { InkStroke, InkStrokePoint } from "../engine/index.ts";

/** 相邻两笔之间的停顿时长近似（ms）。真实停顿未记录（t 相对本笔起点），取固定值 */
export const REPLAY_INTER_STROKE_GAP_MS = 160;

/** 缺时间戳数据退化为匀速时，每个点的固定时长（ms） */
export const REPLAY_UNIFORM_POINT_MS = 12;

/** excalidraw 每个元素的最短占位时长（ms；freedraw 按点数加权可更长） */
export const REPLAY_ELEMENT_MIN_MS = 240;

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

/** 解析中的中间形态：笔画 + 每点原始时间戳（null=缺失/非法） */
interface RawStroke {
  stroke: InkStroke;
  rawTimes: Array<number | null>;
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
    if (!Array.isArray(item.points)) return null;
    const points: InkStrokePoint[] = [];
    const rawTimes: Array<number | null> = [];
    for (const p of item.points) {
      if (!isPlainObject(p)) return null;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return null;
      const pressure = isFiniteNumber(p.p)
        ? Math.min(1, Math.max(0, p.p))
        : 0.5;
      const t = isFiniteNumber(p.t) && p.t >= 0 ? p.t : null;
      // t 先占位 0，buildAtramentModel 归一后回写（保证模型内 InkStroke 契约合法）
      points.push({ x: p.x, y: p.y, p: pressure, t: 0 });
      rawTimes.push(t);
    }
    out.push({
      stroke: {
        tool: item.tool === "highlighter" ? "highlighter" : "pen",
        color:
          typeof item.color === "string" && item.color.length > 0
            ? item.color
            : "#1f2328",
        weight:
          isFiniteNumber(item.weight) && item.weight > 0 ? item.weight : 4,
        points,
      },
      rawTimes,
    });
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

/** 由解析结果组装 atrament 回放模型（时间轴拼接 + 纵横比近似） */
function buildAtramentModel(raws: RawStroke[]): AtramentReplayModel {
  const slots: AtramentReplayModel["slots"] = [];
  let cursor = 0;
  let maxY = 0;
  let hasPoint = false;
  let durationMs = 0;
  for (const { stroke, rawTimes } of raws) {
    const pointTimesMs = normalizePointTimes(rawTimes);
    // 归一结果回写点的 t（模型内 InkStroke 契约合法且自洽）
    for (let i = 0; i < stroke.points.length; i++) {
      const point = stroke.points[i];
      const t = pointTimesMs[i];
      if (point && t !== undefined) point.t = t;
      if (point) {
        maxY = Math.max(maxY, point.y);
        hasPoint = true;
      }
    }
    slots.push({ startMs: cursor, pointTimesMs });
    const lastTime = pointTimesMs[pointTimesMs.length - 1] ?? 0;
    // 只有含点的笔画才推进总时长（空笔画不占进度条）
    if (pointTimesMs.length > 0) durationMs = cursor + lastTime;
    cursor = cursor + lastTime + REPLAY_INTER_STROKE_GAP_MS;
  }
  const contentHeight = hasPoint
    ? Math.min(
        CONTENT_MAX_HEIGHT,
        Math.max(CONTENT_MIN_HEIGHT, maxY + CONTENT_PADDING * 2),
      )
    : EMPTY_CONTENT_HEIGHT;
  return {
    engine: "atrament",
    strokes: raws.map((r) => r.stroke),
    slots,
    durationMs,
    contentHeight,
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
    return buildAtramentModel(parsed);
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
    return {
      engine: "excalidraw",
      elements,
      slots,
      durationMs: cursor,
    };
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
