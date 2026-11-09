import {
  ATTEMPT_ACTIVITY_VERSION,
  type AttemptActivity,
  QUESTION_ACTIVITY_ACTION_TYPES,
  type QuestionActivity,
} from "@tutor/contract";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";

/**
 * 题内活动用时（v1 口径，契约 attempt-activity.ts 文件头为准）——纯函数 +
 * 一个只读投影。与 active-time.ts 的教师面 activeSec（焦点口径）并存、互不改动：
 * 旧统计保留原口径，这里按「有题级动作才归题 / 隐藏与空闲扣除 / 多端重叠不归属
 * / 完全重复去重」现算，不存新列、不信任客户端汇总。
 *
 * 实现分两步：
 * 1. 按作答页会话（viewId；缺省合并为一组）各自回放事件，产出前台聚焦片段
 *    {题, 起, 止, 本次聚焦是否有动作}；同一会话内片段天然不重叠；
 * 2. 多会话片段做一次扫描线：每个基本区间看覆盖它的片段涉及几道题——一道题
 *    归该题（任一片段有动作即 active，否则 observed），多道题归「未归属」。
 */

/** 计算所需的最小事件投影（events 行 + payload 顶层 viewId） */
export interface ActivityEvent {
  readonly type: string;
  readonly clientTs: number;
  readonly questionId: string | null;
  readonly viewId: string | null;
}

interface Segment {
  readonly questionId: string;
  readonly start: number;
  readonly end: number;
  readonly active: boolean;
}

/** 一次聚焦（focus → blur / 切题 / submit）：可被隐藏 / 空闲切成多个前台片段 */
interface Episode {
  questionId: string;
  active: boolean;
  /** 当前前台片段起点；隐藏 / 空闲期间为 null */
  runningFrom: number | null;
  pieces: Array<{ start: number; end: number }>;
}

interface Tally {
  activeMs: number;
  observedMs: number;
  actions: number;
  viewed: boolean;
}

function eventKey(event: ActivityEvent): string {
  return `${event.type}|${event.clientTs}|${event.questionId ?? ""}|${event.viewId ?? ""}`;
}

/** 单会话回放：事件已按 clientTs 升序；返回片段并累计 actions / viewed */
function replaySession(
  ordered: readonly ActivityEvent[],
  tallies: Map<string, Tally>,
): Segment[] {
  const segments: Segment[] = [];
  // 回放状态放在对象里：闭包内赋值不会被控制流分析误收窄成 never
  const state: { episode: Episode | null; hidden: boolean; idle: boolean } = {
    episode: null,
    hidden: false,
    idle: false,
  };
  const tallyOf = (questionId: string): Tally => {
    let tally = tallies.get(questionId);
    if (tally === undefined) {
      tally = { activeMs: 0, observedMs: 0, actions: 0, viewed: false };
      tallies.set(questionId, tally);
    }
    return tally;
  };
  const pause = (at: number) => {
    const episode = state.episode;
    if (episode === null || episode.runningFrom === null) return;
    if (at > episode.runningFrom) {
      episode.pieces.push({ start: episode.runningFrom, end: at });
    }
    episode.runningFrom = null;
  };
  const resume = (at: number) => {
    const episode = state.episode;
    if (
      episode !== null &&
      episode.runningFrom === null &&
      !state.hidden &&
      !state.idle
    ) {
      episode.runningFrom = at;
    }
  };
  const close = (at: number) => {
    const episode = state.episode;
    if (episode === null) return;
    pause(at);
    for (const piece of episode.pieces) {
      segments.push({
        ...piece,
        questionId: episode.questionId,
        active: episode.active,
      });
    }
    state.episode = null;
  };
  const open = (questionId: string, at: number, active: boolean) => {
    close(at);
    tallyOf(questionId).viewed = true;
    state.episode = {
      questionId,
      active,
      runningFrom: state.hidden || state.idle ? null : at,
      pieces: [],
    };
  };

  for (const event of ordered) {
    const at = event.clientTs;
    const questionId = event.questionId;
    const focused = state.episode?.questionId ?? null;
    switch (event.type) {
      case "question_view":
        if (questionId !== null) tallyOf(questionId).viewed = true;
        break;
      case "question_focus":
        if (questionId === null || focused === questionId) break;
        open(questionId, at, false);
        break;
      case "question_blur":
        if (focused !== null && focused === questionId) close(at);
        break;
      case "page_hidden":
        state.hidden = true;
        pause(at);
        break;
      case "page_visible":
        state.hidden = false;
        resume(at);
        break;
      case "idle_start":
        state.idle = true;
        pause(at);
        break;
      case "idle_end":
        state.idle = false;
        resume(at);
        break;
      case "submit":
        close(at);
        return segments; // 交卷后迟到的事件不再计
      default:
        if (
          questionId !== null &&
          QUESTION_ACTIVITY_ACTION_TYPES.has(event.type)
        ) {
          tallyOf(questionId).actions += 1;
          if (state.episode !== null && focused === questionId) {
            state.episode.active = true;
            if (state.idle) {
              // 有动作就不是空闲：队列的 idle_end 可能晚到，这里先恢复计时
              state.idle = false;
              resume(at);
            }
          } else {
            // 没聚焦就有动作（焦点事件丢失 / 旧客户端）：动作本身就是归属依据
            open(questionId, at, true);
          }
        }
    }
  }
  const last = ordered[ordered.length - 1];
  if (last !== undefined) close(last.clientTs);
  return segments;
}

/** 多会话扫描线：按基本区间归属；返回未归属毫秒 */
function attribute(
  segments: readonly Segment[],
  tallies: Map<string, Tally>,
): number {
  const points = [...new Set(segments.flatMap((s) => [s.start, s.end]))].sort(
    (a, b) => a - b,
  );
  const byStart = [...segments].sort((a, b) => a.start - b.start);
  let unattributedMs = 0;
  let cursor = 0;
  const live: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as number;
    const b = points[i + 1] as number;
    while (cursor < byStart.length && (byStart[cursor] as Segment).start <= a) {
      live.push(byStart[cursor] as Segment);
      cursor++;
    }
    for (let j = live.length - 1; j >= 0; j--) {
      if ((live[j] as Segment).end <= a) live.splice(j, 1);
    }
    if (live.length === 0) continue;
    const questionIds = new Set(live.map((s) => s.questionId));
    const span = b - a;
    if (questionIds.size > 1) {
      unattributedMs += span;
      continue;
    }
    const [questionId] = questionIds;
    const tally = tallies.get(questionId as string);
    if (tally === undefined) continue;
    if (live.some((s) => s.active)) tally.activeMs += span;
    else tally.observedMs += span;
  }
  return unattributedMs;
}

/** 事件序列 → 题内活动用时（纯函数；输入可乱序、可含重复） */
export function computeAttemptActivity(
  input: readonly ActivityEvent[],
): AttemptActivity {
  const seen = new Set<string>();
  const ordered = [...input]
    .sort((a, b) => a.clientTs - b.clientTs)
    .filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) return false; // 离线补发 / 双发去重
      seen.add(key);
      return true;
    });
  const sessions = new Map<string, ActivityEvent[]>();
  for (const event of ordered) {
    const key = event.viewId ?? "";
    const list = sessions.get(key);
    if (list === undefined) sessions.set(key, [event]);
    else list.push(event);
  }
  const tallies = new Map<string, Tally>();
  const segments: Segment[] = [];
  for (const list of sessions.values()) {
    segments.push(...replaySession(list, tallies));
  }
  const unattributedMs = attribute(segments, tallies);

  const byQuestion: Record<string, QuestionActivity> = {};
  let activeSecTotal = 0;
  let observedSecTotal = 0;
  for (const [questionId, tally] of tallies) {
    const activeSec = Math.round(tally.activeMs / 1000);
    const observedSec = Math.round(tally.observedMs / 1000);
    activeSecTotal += activeSec;
    observedSecTotal += observedSec;
    byQuestion[questionId] = {
      activeSec,
      observedSec,
      actions: tally.actions,
      viewed: tally.viewed,
    };
  }
  return {
    version: ATTEMPT_ACTIVITY_VERSION,
    byQuestion,
    activeSecTotal,
    observedSecTotal,
    unattributedSec: Math.round(unattributedMs / 1000),
    sessions: Math.max(1, sessions.size),
  };
}

/**
 * 结果视图投影：读该 attempt 全部事件（type / clientTs / questionId + payload 顶层
 * viewId，用 json_extract 不逐行 parse）现算；没有任何事件 → 不携带键。
 */
export function attemptActivityProjection(
  db: Db,
  attemptId: string,
): { activity: AttemptActivity } | Record<string, never> {
  const rows = db
    .select({
      type: events.type,
      clientTs: events.clientTs,
      questionId: events.questionId,
      viewId: sql<
        string | null
      >`json_extract(${events.payloadJson}, '$.viewId')`,
    })
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .orderBy(asc(events.clientTs), asc(events.id))
    .all();
  if (rows.length === 0) return {};
  return { activity: computeAttemptActivity(rows) };
}
