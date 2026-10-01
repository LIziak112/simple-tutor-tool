import { analyzeLectureStructure, type LectureStructure } from "@tutor/md-dsl";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, lectures } from "../db/schema";
import {
  buildIdleIntervals,
  buildLectureVisibleIntervals,
  type Interval,
  intersectIntervals,
  mergeIntervals,
  msToSec,
  orderTraceEvents,
  subtractIntervals,
  type TraceEvent,
  totalIntervalMs,
  traceEventsFromRows,
} from "./trace-intervals";

/**
 * 讲义阅读地图（T4.0b，方案 §4.4.2 学生 × 讲义）：服务端纯函数聚合——
 * 讲义每个 H2/H3 标题、每个可折叠指令、每个 steps 容器各一行 + 汇总从地图
 * 求和。原始 events 不出库、不建新表回写（D13）；分母（expectedSec、指令
 * 总数、steps 总步数）来自 md-dsl 的 analyzeLectureStructure（「组件当传感器、
 * 服务端当尺子」，按 lectureId+updatedAt 缓存）。
 *
 * 判定阈值集中在本文件 TRACE_THRESHOLDS 一份（§4.4.2 前提 3），不散落；
 * 全部 status 是时间代理（「停留足够读完」≠「真读了」），消费方（T4.2/T4.3）
 * 须标注为行为推断。
 */

/** 阈值与口径的集中配置（可调；改这里即改全部判定） */
export const TRACE_THRESHOLDS = {
  /** 节状态：dwell < 20%·expected → 掠过 */
  sectionSkimMaxShare: 0.2,
  /** 节状态：dwell ≥ 50%·expected → 已读（20%–50% 为部分阅读） */
  sectionReadMinShare: 0.5,
  /** 节状态：dwell ≥ 100%·expected → 细读 */
  sectionDeepMinShare: 1.0,
  /** 折叠状态：dwell < 20%·expected → 打开未读 */
  foldReadMinShare: 0.2,
  /** steps 连点判定：相邻 reveal 中位间隔 < 2 秒 */
  stepRushMedianSec: 2,
  /** 未闭合开区间的硬上限（与 trace-intervals 同值；30 分钟） */
  gapCapMs: 30 * 60_000,
  /** 阅读速度基线：中文约 300 字/分钟 */
  readingCharsPerMin: 300,
  /** 公式段落打折（结构分析的 mathChars 分量按此权重计入阅读量） */
  mathContentWeight: 0.3,
} as const;

/** 加权字数 → 预期阅读秒数（公式段打折；至少 1 秒，避免零除与零宽区间） */
export function expectedSecOf(input: {
  textChars: number;
  mathChars: number;
}): number {
  const weighted =
    input.textChars + input.mathChars * TRACE_THRESHOLDS.mathContentWeight;
  const charsPerSec = TRACE_THRESHOLDS.readingCharsPerMin / 60;
  return Math.max(1, Math.round(weighted / charsPerSec));
}

// ---------- 地图行类型 ----------

/**
 * 节状态：not-reached=未到达 / skimmed=掠过(<20%) / partial=部分阅读(20–50%) /
 * read=已读(≥50%) / deep=细读(≥100%)。方案 §4.4.2(a) 给出 20/50/100 三个阈值，
 * 20–50% 带未命名——补「部分阅读」（见任务报告待裁决）。
 */
export type SectionStatus =
  | "not-reached"
  | "skimmed"
  | "partial"
  | "read"
  | "deep";

export interface LectureMapSectionRow {
  readonly headingIndex: number;
  readonly level: 2 | 3;
  readonly text: string;
  readonly reached: boolean;
  /** visible ∩ focus（未扣 idle；教师端可见「含挂机」） */
  readonly rawDwellSec: number;
  /** 再扣 idle 后的有效停留 */
  readonly dwellSec: number;
  readonly expectedSec: number;
  readonly status: SectionStatus;
}

export type FoldStatus = "not-opened" | "opened-unread" | "read";

export interface LectureMapFoldRow {
  readonly docIndex: number;
  readonly name: string;
  readonly hostHeadingIndex: number;
  readonly opened: boolean;
  readonly openCount: number;
  /** 首次 open 距该节 focus 开始的秒数；该节未被聚焦过为 null */
  readonly firstOpenOffsetSec: number | null;
  readonly rawDwellSec: number;
  readonly dwellSec: number;
  readonly expectedSec: number;
  readonly status: FoldStatus;
}

export type StepsStatus =
  | "not-started"
  | "rush-skipped"
  | "step-by-step"
  | "incomplete";

export interface LectureMapStepsRow {
  readonly docIndex: number;
  readonly hostHeadingIndex: number;
  readonly revealedCount: number;
  readonly total: number;
  /** 相邻 reveal 的间隔（秒，升序） */
  readonly paceSec: readonly number[];
  readonly status: StepsStatus;
}

export interface LectureMapSummary {
  /** Σ 各节 dwellSec（从地图求和） */
  readonly readSec: number;
  /** 可见总时长（viewId 并集；版本错位事件的时间只体现在这里） */
  readonly totalVisibleSec: number;
  readonly sectionCoverage: number;
  /** 分母 = 服务端解析的可折叠指令总数 */
  readonly foldOpenRate: number;
  readonly hintOpenCount: number;
  readonly solutionOpenCount: number;
  readonly stepsRushContainerCount: number;
  readonly stepsTotalContainers: number;
  readonly stepsOverallMedianPaceSec: number | null;
  /** 版本错位（只计总时长、不定位）的定位类事件数 */
  readonly degradedEventCount: number;
}

export interface LectureReadingMap {
  readonly sections: readonly LectureMapSectionRow[];
  readonly folds: readonly LectureMapFoldRow[];
  readonly steps: readonly LectureMapStepsRow[];
  readonly summary: LectureMapSummary;
}

// ---------- 版本判定与事件归一 ----------

/** 携带条目定位语义的事件（headingIndex / (name, index) 参与逐项定位） */
function isPositionedEvent(event: TraceEvent): boolean {
  return (
    event.type === "lecture_section_focus" ||
    event.type === "lecture_toc_jump" ||
    event.type === "lecture_expand" ||
    (event.type === "directive_interact" && event.host === "lecture")
  );
}

/**
 * 版本判定（§4.4.2 前提 1）：带 lectureUpdatedAt 则精确比对；缺省回退
 * serverTs（服务端接收时刻）≥ 当前 updatedAt 视为当前版本（从未编辑过的
 * 讲义全部命中；两说皆无按降级处理——保守）。
 */
function isVersionMatched(
  event: TraceEvent,
  currentUpdatedAt: string,
): boolean {
  if (event.lectureUpdatedAt !== undefined) {
    return event.lectureUpdatedAt === currentUpdatedAt;
  }
  if (event.serverTs !== undefined) {
    return event.serverTs >= currentUpdatedAt;
  }
  return false;
}

/** 归一后的指令交互（directive_interact{host:lecture}；存量 lecture_expand
 * 读侧归一为 action=open，§6 决策 1——旧 index 口径定位不到结构行时只进
 * summary 计数，已知限制见任务报告） */
interface NormalizedInteraction {
  readonly ts: number;
  readonly name: string;
  readonly index: number;
  readonly action: "open" | "close" | "reveal";
  readonly step?: number;
}

function normalizedInteractions(
  ordered: readonly TraceEvent[],
  currentUpdatedAt: string,
): NormalizedInteraction[] {
  const out: NormalizedInteraction[] = [];
  for (const e of ordered) {
    if (e.type === "directive_interact" && e.host === "lecture") {
      if (e.name === undefined || e.index === undefined) continue;
      if (!isVersionMatched(e, currentUpdatedAt)) continue;
      const action =
        e.action === "open" || e.action === "close" || e.action === "reveal"
          ? e.action
          : "open";
      out.push({
        ts: e.clientTs,
        name: e.name,
        index: e.index,
        action,
        ...(action === "reveal" && e.step !== undefined
          ? { step: e.step }
          : {}),
      });
    } else if (e.type === "lecture_expand") {
      // 存量事件：payload.directive 为指令名（traceEventsFromRows 已归一进
      // name；直接构造的 TraceEvent 可能只带 directive 字段）
      const name = e.name ?? e.directive;
      if (name === undefined || e.index === undefined) continue;
      if (!isVersionMatched(e, currentUpdatedAt)) continue;
      out.push({ ts: e.clientTs, name, index: e.index, action: "open" });
    }
  }
  return out;
}

function medianOf(sortedValues: readonly number[]): number | null {
  if (sortedValues.length === 0) return null;
  const mid = Math.floor(sortedValues.length / 2);
  const lower = sortedValues[mid - 1];
  const upper = sortedValues[mid];
  if (sortedValues.length % 2 === 1) {
    return sortedValues[mid] ?? null;
  }
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

// ---------- 地图计算 ----------

/** 环境与 focus 区间（各 dwell 复用） */
interface AmbientIntervals {
  visibleUnion: readonly Interval[];
  idle: readonly Interval[];
  /** 各节原始 focus 区间（[focus_i, focus_{i+1}) 线性划分；末段到可见收尾） */
  readonly sectionRaw: Map<number, Interval[]>;
  /** 每节首次 focus 时刻（firstOpenOffsetSec 用） */
  readonly firstFocusTs: Map<number, number>;
  /** 版本匹配的 section_focus 时刻（折叠停留的「节切换」边界用） */
  readonly matchedFocusTs: readonly number[];
}

function buildAmbient(
  ordered: readonly TraceEvent[],
  currentUpdatedAt: string,
): AmbientIntervals {
  const visibleUnion = mergeIntervals(buildLectureVisibleIntervals(ordered));
  const idle = buildIdleIntervals(ordered);

  const matchedFocus = ordered.filter(
    (e): e is TraceEvent & { headingIndex: number } =>
      e.type === "lecture_section_focus" &&
      e.headingIndex !== undefined &&
      isVersionMatched(e, currentUpdatedAt),
  );
  const sectionRaw = new Map<number, Interval[]>();
  const firstFocusTs = new Map<number, number>();
  /** 可见收尾：visible 并集内晚于 focus 时刻的最晚终点（末段终点不依赖
   * 「下一个事件时刻差」——GA4 最后一页零时长教训，§4.4.2 前提 4） */
  const visibleEndAfter = (ts: number): number => {
    let end = ts;
    for (const interval of visibleUnion) {
      if (interval.end > end) end = interval.end;
    }
    return end;
  };
  for (const [i, event] of matchedFocus.entries()) {
    if (!firstFocusTs.has(event.headingIndex)) {
      firstFocusTs.set(event.headingIndex, event.clientTs);
    }
    const next = matchedFocus[i + 1];
    const end =
      next !== undefined ? next.clientTs : visibleEndAfter(event.clientTs);
    if (end > event.clientTs) {
      const list = sectionRaw.get(event.headingIndex) ?? [];
      list.push({ start: event.clientTs, end });
      sectionRaw.set(event.headingIndex, list);
    }
  }
  return {
    visibleUnion,
    idle,
    sectionRaw,
    firstFocusTs,
    matchedFocusTs: matchedFocus.map((e) => e.clientTs),
  };
}

/** raw（visible∩区间）与 dwell（再扣 idle）的秒数对 */
function dwellPair(
  raw: readonly Interval[],
  ambient: AmbientIntervals,
): { rawDwellSec: number; dwellSec: number } {
  const visibleOnly = intersectIntervals(raw, ambient.visibleUnion);
  const effective = subtractIntervals(visibleOnly, ambient.idle);
  return {
    rawDwellSec: msToSec(totalIntervalMs(visibleOnly)),
    dwellSec: msToSec(totalIntervalMs(effective)),
  };
}

/**
 * 计算讲义阅读地图（纯函数）。
 * @param events 该学生 × 该讲义的事件流（含 idle 等环境事件；loadLectureTraceEvents）
 * @param structure analyzeLectureStructure 的解析结果（分母）
 * @param options.currentUpdatedAt 讲义当前 updatedAt（版本定位基准）
 */
export function computeLectureReadingMap(
  events: readonly TraceEvent[],
  structure: LectureStructure,
  options: { readonly currentUpdatedAt: string },
): LectureReadingMap {
  const currentUpdatedAt = options.currentUpdatedAt;
  const ordered = orderTraceEvents(events);
  const ambient = buildAmbient(ordered, currentUpdatedAt);

  // toc_jump 也算到达（用户明确去了该节）
  const reachedHeadings = new Set<number>(
    ordered
      .filter(
        (e) =>
          (e.type === "lecture_toc_jump" ||
            e.type === "lecture_section_focus") &&
          e.headingIndex !== undefined &&
          isVersionMatched(e, currentUpdatedAt),
      )
      .map((e) => e.headingIndex as number),
  );

  // 版本错位的定位事件计数（只计总时长不定位）
  const degradedEventCount = ordered.filter(
    (e) => isPositionedEvent(e) && !isVersionMatched(e, currentUpdatedAt),
  ).length;

  // ---- (a) 节行 ----
  const sections: LectureMapSectionRow[] = structure.sections.map((section) => {
    const expectedSec = expectedSecOf(section);
    const raw = ambient.sectionRaw.get(section.headingIndex) ?? [];
    const { rawDwellSec, dwellSec } = dwellPair(raw, ambient);
    const reached = reachedHeadings.has(section.headingIndex);
    let status: SectionStatus = "not-reached";
    if (reached) {
      const share = dwellSec / expectedSec;
      if (share >= TRACE_THRESHOLDS.sectionDeepMinShare) status = "deep";
      else if (share >= TRACE_THRESHOLDS.sectionReadMinShare) status = "read";
      else if (share >= TRACE_THRESHOLDS.sectionSkimMaxShare)
        status = "partial";
      else status = "skimmed";
    }
    return {
      headingIndex: section.headingIndex,
      level: section.level,
      text: section.text,
      reached,
      rawDwellSec,
      dwellSec,
      expectedSec,
      status,
    };
  });

  // ---- (b) 折叠指令行 + name 计数 ----
  const interactions = normalizedInteractions(ordered, currentUpdatedAt);
  /** hint/solution 的 open 计数（含定位不到行的存量归一事件，按名累计） */
  let hintOpenCount = 0;
  let solutionOpenCount = 0;
  for (const interaction of interactions) {
    if (interaction.action !== "open") continue;
    if (interaction.name === "hint") hintOpenCount += 1;
    else if (interaction.name === "solution") solutionOpenCount += 1;
  }

  const folds: LectureMapFoldRow[] = structure.folds.map((fold) => {
    const opens = interactions.filter(
      (i) =>
        i.action === "open" &&
        i.name === fold.name &&
        i.index === fold.docIndex,
    );
    const closes = interactions.filter(
      (i) =>
        i.action === "close" &&
        i.name === fold.name &&
        i.index === fold.docIndex,
    );
    const hostFirst = ambient.firstFocusTs.get(fold.hostHeadingIndex);
    const firstOpenTs = opens[0]?.ts;
    const firstOpenOffsetSec =
      hostFirst !== undefined && firstOpenTs !== undefined
        ? msToSec(firstOpenTs - hostFirst)
        : null;

    // 停留：open → close（或下一节切换 / 30 分钟硬上限），∩visible − idle，并集
    const rawIntervals: Interval[] = [];
    for (const open of opens) {
      let end = open.ts + TRACE_THRESHOLDS.gapCapMs;
      for (const close of closes) {
        if (close.ts > open.ts) {
          end = Math.min(end, close.ts);
          break;
        }
      }
      const nextFocus = ambient.matchedFocusTs.find((ts) => ts > open.ts);
      if (nextFocus !== undefined) end = Math.min(end, nextFocus);
      if (end > open.ts) rawIntervals.push({ start: open.ts, end });
    }
    const { rawDwellSec, dwellSec } = dwellPair(
      mergeIntervals(rawIntervals),
      ambient,
    );
    const expectedSec = expectedSecOf({
      textChars: fold.innerTextChars,
      mathChars: fold.innerMathChars,
    });
    const status: FoldStatus =
      opens.length === 0
        ? "not-opened"
        : dwellSec >= TRACE_THRESHOLDS.foldReadMinShare * expectedSec
          ? "read"
          : "opened-unread";
    return {
      docIndex: fold.docIndex,
      name: fold.name,
      hostHeadingIndex: fold.hostHeadingIndex,
      opened: opens.length > 0,
      openCount: opens.length,
      firstOpenOffsetSec,
      rawDwellSec,
      dwellSec,
      expectedSec,
      status,
    };
  });

  // ---- (c) steps 容器行 ----
  const stepsRows: LectureMapStepsRow[] = structure.steps.map((container) => {
    const reveals = interactions
      .filter(
        (i) =>
          i.action === "reveal" &&
          i.name === "steps" &&
          i.index === container.docIndex,
      )
      .sort((a, b) => a.ts - b.ts);
    const revealedCount = reveals.reduce(
      (max, r) => Math.max(max, r.step ?? 1),
      0,
    );
    const paceSec: number[] = [];
    for (const [i, reveal] of reveals.entries()) {
      const prev = reveals[i - 1];
      if (prev !== undefined) paceSec.push(msToSec(reveal.ts - prev.ts));
    }
    paceSec.sort((a, b) => a - b);
    const medianPace = medianOf(paceSec);
    let status: StepsStatus = "not-started";
    if (reveals.length > 0) {
      if (
        medianPace !== null &&
        medianPace < TRACE_THRESHOLDS.stepRushMedianSec
      ) {
        status = "rush-skipped"; // 连点信号优先于完成度标签（更有诊断价值）
      } else if (revealedCount >= container.totalSteps) {
        status = "step-by-step";
      } else {
        status = "incomplete";
      }
    }
    return {
      docIndex: container.docIndex,
      hostHeadingIndex: container.hostHeadingIndex,
      revealedCount,
      total: container.totalSteps,
      paceSec,
      status,
    };
  });

  // ---- (d) 汇总（从地图求和） ----
  const readSec = sections.reduce((sum, s) => sum + s.dwellSec, 0);
  const reachedCount = sections.filter((s) => s.reached).length;
  const openedFolds = folds.filter((f) => f.opened).length;
  const allPaces = stepsRows
    .flatMap((s) => [...s.paceSec])
    .sort((a, b) => a - b);

  return {
    sections,
    folds,
    steps: stepsRows,
    summary: {
      readSec,
      totalVisibleSec: msToSec(totalIntervalMs(ambient.visibleUnion)),
      sectionCoverage:
        sections.length === 0 ? 0 : reachedCount / sections.length,
      foldOpenRate: folds.length === 0 ? 0 : openedFolds / folds.length,
      hintOpenCount,
      solutionOpenCount,
      stepsRushContainerCount: stepsRows.filter(
        (s) => s.status === "rush-skipped",
      ).length,
      stepsTotalContainers: stepsRows.length,
      stepsOverallMedianPaceSec: medianOf(allPaces),
      degradedEventCount,
    },
  };
}

// ---------- 结构缓存（按 lectureId + updatedAt） ----------

/** 缓存容量（FIFO 淘汰；讲义结构按版本键，编辑后自动失效） */
const STRUCTURE_CACHE_MAX = 32;
const structureCache = new Map<string, LectureStructure>();

/** 取（或解析并缓存）讲义结构：键 = lectureId@updatedAt，讲义一改自动失效 */
export function getLectureStructure(
  lectureId: string,
  updatedAt: string,
  markdown: string,
): LectureStructure {
  const key = `${lectureId}@${updatedAt}`;
  const cached = structureCache.get(key);
  if (cached !== undefined) return cached;
  const structure = analyzeLectureStructure(markdown);
  structureCache.set(key, structure);
  if (structureCache.size > STRUCTURE_CACHE_MAX) {
    const oldest = structureCache.keys().next();
    if (oldest.done !== true) structureCache.delete(oldest.value);
  }
  return structure;
}

// ---------- 事件装载（thin loader；T4.1 的查询入口） ----------

/**
 * 读「学生 × 讲义」的事件流：讲义域事件 + **无归属的 idle 事件**——
 * T4.0a schema 里 idle/net 不带 lectureId（环境族无讲义语义），学生级 idle
 * 近似为讲义空闲：idle 的语义是「该生在任一队列实例域内无输入」，与「没在
 * 读讲义」一致（单设备使用是常态）。net 事件不参与讲义地图。
 *
 * 两个析取支都必须限定 studentId（口径「学生 × 讲义」）：同班多学生共读
 * 同一讲义是常态，只按 lectureId 取会把别的学生的阅读聚进本人地图
 * （跨学生污染回归见 analytics-service.test.ts）；存量 studentId 为 NULL
 * 的旧讲义事件按 D8 读侧非空过滤，不进任何学生的地图。
 */
export function loadLectureTraceEvents(
  db: Db,
  studentId: string,
  lectureId: string,
): TraceEvent[] {
  const rows = db
    .select({
      type: events.type,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      payloadJson: events.payloadJson,
    })
    .from(events)
    .where(
      or(
        and(eq(events.lectureId, lectureId), eq(events.studentId, studentId)),
        and(
          eq(events.studentId, studentId),
          isNull(events.lectureId),
          inArray(events.type, ["idle_start", "idle_end"]),
        ),
      ),
    )
    .all();
  return traceEventsFromRows(rows);
}

/** 便捷入口：取讲义行 → 结构（缓存）→ 事件流 → 地图（原始 events 不出库） */
export function lectureReadingMapFor(
  db: Db,
  studentId: string,
  lectureId: string,
): LectureReadingMap | null {
  const lecture = db
    .select({
      id: lectures.id,
      markdown: lectures.markdown,
      updatedAt: lectures.updatedAt,
    })
    .from(lectures)
    .where(and(eq(lectures.id, lectureId), isNull(lectures.deletedAt)))
    .get();
  if (lecture === undefined) return null;
  const structure = getLectureStructure(
    lecture.id,
    lecture.updatedAt,
    lecture.markdown,
  );
  const trace = loadLectureTraceEvents(db, studentId, lectureId);
  return computeLectureReadingMap(trace, structure, {
    currentUpdatedAt: lecture.updatedAt,
  });
}
