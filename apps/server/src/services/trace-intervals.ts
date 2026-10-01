/**
 * 学习痕迹聚合的区间运算统一工具（T4.0b，方案 §5.0-D15 用例锁定）：
 * 事件 → 区间（viewId 配对、重复闭事件忽略、未闭合开区间 gap-cap 截断、
 * 负时长 clamp 0）+ 区间集合运算（并/交/差/总时长）+ 事件排序确定性（D16）。
 *
 * 与 active-time 的关系：active-time.ts 的 26 条用例锁定既有 activeSec 口径
 * （本题不得改动它）；本模块只服务**新指标**（讲义阅读地图、离线占比、
 * 提示停留等），两套互不引用。
 *
 * 红线（§5.0-D15 逐条）：
 * - 按 viewId 分流 → 区间求并集（双标签页/双设备并行不叠计）；
 * - 未闭合开区间在 min(证据终点, 下一会话起点, idle_start, 硬上限 30 分钟)
 *   处截断（Caliper gap-cap；「证据终点」= 下一会话开始前该流最后一个事件
 *   ——页面被杀时只计到有事件证明存活的那一刻，总时长不虚高）；
 * - 重复闭事件忽略（与 active-time 规则 3「重复 hidden 忽略」同构）；
 * - 负时长 clamp 0（客户端时钟回拨防御）；
 * - **hint_open 的 clientTs（服务端时钟，§2.6-3）绝不参与任何区间运算**——
 *   本模块的调用方负责过滤，TraceEvent 也不应从 hint_open 行构造。
 */

/** 半开区间 [startMs, endMs)（epoch 毫秒） */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * 聚合层的最小事件投影：events 表行（或契约事件）经 fromEventRow / 调用方
 * 映射后的形状。payload 需要的字段全部摊平为可选（缺省 = 不参与对应运算）。
 */
export interface TraceEvent {
  readonly type: string;
  readonly clientTs: number;
  /** 服务端接收时间（UTC ISO）——仅 lectureUpdatedAt 缺省时的版本判定回退用 */
  readonly serverTs?: string | undefined;
  /** 阅读会话标识（lecture_visible/hidden payload；其他事件缺省） */
  readonly viewId?: string | undefined;
  readonly questionId?: string | undefined;
  /** host=result 的 directive_interact 携带的 attemptId */
  readonly attemptId?: string | undefined;
  /** ink_stroke_batch 的本批笔画数（新指标暂不消费，投影保留） */
  readonly strokes?: number | undefined;
  /** lecture_section_focus / lecture_toc_jump 的目录序号（0 起） */
  readonly headingIndex?: number | undefined;
  /** directive_interact 的判别字段 */
  readonly host?: string | undefined;
  readonly name?: string | undefined;
  readonly index?: number | undefined;
  readonly action?: string | undefined;
  /** steps reveal 的容器内步序号（1 起） */
  readonly step?: number | undefined;
  /** 讲义版本定位（ISO） */
  readonly lectureUpdatedAt?: string | undefined;
  /** ink_fullscreen */
  readonly on?: boolean | undefined;
  /** ink_edit_batch 四计数 */
  readonly erase?: number | undefined;
  readonly undo?: number | undefined;
  readonly redo?: number | undefined;
  readonly clear?: number | undefined;
  /** lecture_expand 存量事件的指令名（payload.directive） */
  readonly directive?: string | undefined;
}

/**
 * 同 clientTs 的 type 优先级（D16 排序确定性；events.id 是 randomUUID 不能作
 * tie-break）。设计原则：闭事件排在开事件之前（同刻收尾再开新段，区间配对
 * 的规范序）；环境事件排在业务事件之前。未列出的类型按字典序排在已知之后。
 */
const EVENT_TYPE_ORDER: Readonly<Record<string, number>> = {
  lecture_hidden: 0,
  lecture_visible: 1,
  idle_end: 2,
  idle_start: 3,
  net_online: 4,
  net_offline: 5,
  page_visible: 6,
  page_hidden: 7,
  question_blur: 8,
  question_focus: 9,
  submit: 10,
  lecture_section_focus: 20,
  lecture_toc_jump: 21,
  directive_interact: 22,
  lecture_expand: 23,
  ink_edit_batch: 24,
  ink_fullscreen: 25,
};

/** 排序：clientTs 升序 → type 优先级 → type 字典序（整体确定） */
export function orderTraceEvents(events: readonly TraceEvent[]): TraceEvent[] {
  return [...events].sort(
    (a, b) =>
      a.clientTs - b.clientTs ||
      (EVENT_TYPE_ORDER[a.type] ?? 100) - (EVENT_TYPE_ORDER[b.type] ?? 100) ||
      a.type.localeCompare(b.type),
  );
}

// ---------- 区间集合运算 ----------

/** 求并集（排序后线性合并相邻/重叠区间；乱序输入稳定） */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start) // 负/零时长直接丢弃（clamp 0）
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && cur.start <= last.end) {
      if (cur.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: cur.end };
      }
      continue;
    }
    merged.push(cur);
  }
  return merged;
}

/** 求交集（两输入各自先 merge；空交返回空数组） */
export function intersectIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i] as Interval;
    const r = right[j] as Interval;
    const start = Math.max(l.start, r.start);
    const end = Math.min(l.end, r.end);
    if (end > start) out.push({ start, end });
    if (l.end <= r.end) i += 1;
    else j += 1;
  }
  return out;
}

/** a − b（扣除 b 覆盖的部分） */
export function subtractIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): Interval[] {
  const sub = mergeIntervals(b);
  const out: Interval[] = [];
  for (const interval of mergeIntervals(a)) {
    let cursor = interval.start;
    for (const s of sub) {
      if (s.end <= cursor) continue;
      if (s.start >= interval.end) break;
      const cut = Math.max(s.start, cursor);
      if (cut > cursor) out.push({ start: cursor, end: cut });
      cursor = Math.max(cursor, s.end);
      if (cursor >= interval.end) break;
    }
    if (interval.end > cursor) out.push({ start: cursor, end: interval.end });
  }
  return out;
}

/** 区间总时长（毫秒；负/零段计 0） */
export function totalIntervalMs(intervals: readonly Interval[]): number {
  let total = 0;
  for (const i of intervals) total += Math.max(0, i.end - i.start);
  return total;
}

/** 毫秒 → 秒（四舍五入，与 activeSec 的取整口径一致） */
export function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

// ---------- events 表行 → TraceEvent ----------

/** traceEventsFromRows 接受的最小行投影（events 表 SELECT 子集可直接传入） */
export interface TraceEventRow {
  readonly type: string;
  readonly clientTs: number;
  readonly serverTs: string;
  readonly payloadJson: string;
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function boolOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * events 表行批量映射为 TraceEvent（payloadJson 摊平；未知键忽略）。
 * 解析失败的行按 {type, clientTs, serverTs} 兜底（区间族事件只需要这三列）。
 */
export function traceEventsFromRows(
  rows: readonly TraceEventRow[],
): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.payloadJson);
      if (parsed !== null && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // 兜底：不带 payload 字段
    }
    out.push({
      type: row.type,
      clientTs: row.clientTs,
      serverTs: row.serverTs,
      viewId: strOf(payload.viewId),
      questionId: strOf(payload.questionId),
      attemptId: strOf(payload.attemptId),
      headingIndex: numOf(payload.headingIndex),
      host: strOf(payload.host),
      name: strOf(payload.name) ?? strOf(payload.directive),
      index: numOf(payload.index),
      action: strOf(payload.action),
      step: numOf(payload.step),
      lectureUpdatedAt: strOf(payload.lectureUpdatedAt),
      on: boolOf(payload.on),
      erase: numOf(payload.erase),
      undo: numOf(payload.undo),
      redo: numOf(payload.redo),
      clear: numOf(payload.clear),
      strokes: numOf(payload.strokes),
    });
  }
  return out;
}

// ---------- 事件 → 区间（配对与 gap-cap） ----------

/** 未闭合开区间的硬上限（Caliper gap-cap；方案 §4.4.2 前提 4：30 分钟） */
export const TRACE_GAP_CAP_MS = 30 * 60_000;

/**
 * 「证据终点」：下一会话起点（或流末）之前的最后一个事件时刻。
 * 页面被杀时只计到有事件证明存活的那一刻（GA4「最后一页零时长」的防反例：
 * 终点取证据而非下一个事件本身，长会话不被截断到第二个事件）。
 */
function orderedTraceBoundary(
  ordered: readonly TraceEvent[],
  after: number,
): number | null {
  // 找到 after 之后第一个 lecture_visible（新会话）；证据终点在其前一个事件
  let boundary: number | null = null;
  for (const e of ordered) {
    if (e.clientTs <= after) continue;
    if (e.type === "lecture_visible") break;
    boundary = e.clientTs;
  }
  return boundary;
}

/**
 * 讲义可见区间（按 viewId 配对）：
 * - visible→hidden 成一段；重复 hidden / 孤立 hidden / 已开再开 忽略；
 * - 同毫秒 visible+hidden 对（页面亚毫秒生存期，自动化轨迹可产生；D16 规范序
 *   hidden 先到被当孤立忽略）按 0 时长会话闭环即弃——不产生区间，防
 *   「未闭合」按下一会话起点截断出幽灵停留（Opus 复测 (C)）；
 * - 未闭合开区间收尾 = min(证据终点, 下一会话起点, 首个 idle_start,
 *   start + 30 分钟)；
 * - 负时长 clamp 0（直接丢弃）。
 * 返回**未合并**的分 viewId 区间（调用方按需 mergeIntervals 求并集）。
 */
export function buildLectureVisibleIntervals(
  events: readonly TraceEvent[],
): Interval[] {
  const ordered = orderTraceEvents(events);
  const out: Interval[] = [];
  const openByView = new Map<string, number>();
  /** 被当孤立忽略的 hidden（viewId → clientTs），仅用于同刻 visible 回配 */
  const ignoredHiddenAt = new Map<string, number>();
  for (const e of ordered) {
    if (e.type === "lecture_visible" && e.viewId !== undefined) {
      if (ignoredHiddenAt.get(e.viewId) === e.clientTs) {
        // 同毫秒对：0 时长会话闭环即弃（不 push；亚毫秒生存期真实时长为 0）
        ignoredHiddenAt.delete(e.viewId);
        continue;
      }
      if (!openByView.has(e.viewId)) openByView.set(e.viewId, e.clientTs);
      continue;
    }
    if (e.type === "lecture_hidden" && e.viewId !== undefined) {
      const start = openByView.get(e.viewId);
      if (start === undefined) {
        // 孤立 hidden（重复/双兜底双发）：不再无条件丢弃——记下时刻供同毫秒
        // visible 回配；不同刻的记录天然不会被消费，等价于原「忽略」
        ignoredHiddenAt.set(e.viewId, e.clientTs);
        continue;
      }
      openByView.delete(e.viewId);
      if (e.clientTs > start) out.push({ start, end: e.clientTs });
    }
    // idle 不在循环内截断：中途 idle（idle_end 后有后续事件）只是暂停，
    // 会话继续（停留由调用方减 idle 区间）；只有「尾随 idle」才截断未闭合
    // 会话（见 capOpenInterval）
  }
  for (const [viewId, start] of openByView) {
    const capped = capOpenInterval(ordered, start);
    if (capped !== null) out.push(capped);
    openByView.delete(viewId);
  }
  return out;
}

/**
 * 未闭合开区间的收尾（§5.0-D15）：min(证据终点, 下一会话起点, 尾随 idle_start,
 * start + 硬上限)。
 * - 证据终点 = 下一会话（任意 viewId 的 lecture_visible）前的最后一个事件
 *   时刻——页面被杀时只计到有事件证明存活的那一刻（GA4「最后一页零时长」
 *   的防反例：长会话不被截断到第二个事件）；
 * - 尾随 idle：start 之后首个 idle_start 且其后**再无任何非 idle 事件**——
 *   用户在讲义页上空闲后再无动作，idle_start 即阅读结束（§4.4.1 附带收益）；
 *   中途 idle（idle_end 后有阅读事件）不截断，会话继续；
 * - 无任何证据事件时按 Caliper TimedOut 记硬上限——实践中讲义页加载即有
 *   section_focus(0)，孤 visible 几乎不出现；宁可该极端场景高估 30 分钟，
 *   也不把「hidden 双兜底都失败」的真实长阅读记成 0。
 */
function capOpenInterval(
  ordered: readonly TraceEvent[],
  start: number,
): Interval | null {
  const candidates: number[] = [start + TRACE_GAP_CAP_MS];
  // 下一会话起点：start 之后最早的 lecture_visible（任何 viewId）
  for (const e of ordered) {
    if (e.clientTs <= start) continue;
    if (e.type === "lecture_visible") {
      candidates.push(e.clientTs);
      break;
    }
  }
  // 证据终点：下一会话（或流末）之前的最后一个事件时刻
  const evidence = orderedTraceBoundary(ordered, start);
  if (evidence !== null && evidence > start) candidates.push(evidence);
  // 尾随 idle：流末连续的 idle 事件段里最早的 idle_start（其后再无阅读/
  // 环境事件）——从流尾倒扫
  let trailingIdleStart: number | null = null;
  let i = ordered.length - 1;
  while (
    i >= 0 &&
    (ordered[i]?.type === "idle_start" || ordered[i]?.type === "idle_end")
  ) {
    i -= 1;
  }
  for (let j = i + 1; j < ordered.length; j += 1) {
    const e = ordered[j];
    if (e?.type === "idle_start" && e.clientTs > start) {
      trailingIdleStart = e.clientTs;
      break;
    }
  }
  if (trailingIdleStart !== null) candidates.push(trailingIdleStart);
  const end = Math.min(...candidates);
  return end > start ? { start, end } : null;
}

/**
 * idle 区间（idle_start→idle_end）：重复 idle_start 忽略、孤立 idle_end 忽略；
 * 未闭合 idle_start 收尾 = 流内最后事件（证据终点）与硬上限的较小者。
 */
export function buildIdleIntervals(events: readonly TraceEvent[]): Interval[] {
  const ordered = orderTraceEvents(events);
  const out: Interval[] = [];
  let open: number | null = null;
  for (const e of ordered) {
    if (e.type === "idle_start") {
      if (open === null) open = e.clientTs;
      continue;
    }
    if (e.type === "idle_end") {
      if (open === null) continue;
      if (e.clientTs > open) out.push({ start: open, end: e.clientTs });
      open = null;
    }
  }
  if (open !== null && ordered.length > 0) {
    const last = ordered[ordered.length - 1] as TraceEvent;
    const end = Math.min(last.clientTs, open + TRACE_GAP_CAP_MS);
    if (end > open) out.push({ start: open, end });
  }
  return out;
}

/**
 * 离线区间（net_offline→net_online）：未闭合 net_offline 收尾 = 流内最后事件
 * 与硬上限的较小者（保守：离线期间页面被杀只计到证据终点）。
 */
export function buildOfflineIntervals(
  events: readonly TraceEvent[],
): Interval[] {
  const ordered = orderTraceEvents(events);
  const out: Interval[] = [];
  let open: number | null = null;
  for (const e of ordered) {
    if (e.type === "net_offline") {
      if (open === null) open = e.clientTs;
      continue;
    }
    if (e.type === "net_online") {
      if (open === null) continue;
      if (e.clientTs > open) out.push({ start: open, end: e.clientTs });
      open = null;
    }
  }
  if (open !== null && ordered.length > 0) {
    const last = ordered[ordered.length - 1] as TraceEvent;
    const end = Math.min(last.clientTs, open + TRACE_GAP_CAP_MS);
    if (end > open) out.push({ start: open, end });
  }
  return out;
}
