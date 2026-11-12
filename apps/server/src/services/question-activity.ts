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
 * 实现分三步：
 * 0. 按服务端交卷时刻筛选并去重（任一端交卷后各端事件都不计），
 *    再把服务端直记的动作事件（question_submit / hint_open：服务器时钟、无会话
 *    标识）归入最近聚焦该题的会话；
 * 1. 按作答页会话（viewId；缺省合并为一组）各自回放事件，产出前台聚焦片段
 *    {题, 起, 止, 本次聚焦是否有动作, 会话}；同一会话内片段天然不重叠；
 * 2. 多会话片段做一次扫描线：每个基本区间看覆盖它的片段涉及几道题——一道题
 *    归该题（任一片段有动作即 active，否则 observed），多道题归「未归属」；
 *    同时统计同时在前台的会话数峰值（「N 端同开」展示口径）。
 */

/** 计算所需的最小事件投影（events 行 + payload 顶层 viewId） */
export interface ActivityEvent {
  readonly type: string;
  readonly clientTs: number;
  readonly questionId: string | null;
  readonly viewId: string | null;
  /** 服务端接收时刻（events.server_ts，UTC ISO）；交卷截止锚点用，可缺省 */
  readonly serverTs?: string | null;
}

/**
 * 服务端直记的动作事件：服务器时钟、payload 无 viewId（event-service 的
 * recordQuestionSubmitEvent / recordHintOpenEvent）。它们不能当区间锚点与客户端
 * 时钟的事件混排开段，只用来标记「那次聚焦有动作」（归入会话 + 追认收尾段）。
 */
const SERVER_RECORDED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "question_submit",
  "hint_open",
]);

/** 回放用事件：adoptServerRecordedActions 给服务端直记事件打标 */
interface ReplayEvent extends ActivityEvent {
  readonly serverRecorded?: boolean;
}

interface Segment {
  readonly questionId: string;
  readonly start: number;
  readonly end: number;
  /** 可在收尾后被服务端记录的逐题提交追认为有动作（见 replaySession） */
  active: boolean;
  /** 所属会话（viewId；缺省组为空串），同开峰值按它计 */
  readonly session: string;
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
  session: string,
  ordered: readonly ReplayEvent[],
  tallies: Map<string, Tally>,
): Segment[] {
  const segments: Segment[] = [];
  /**
   * 每题最近一次已收尾聚焦的片段（服务端直记动作迟到时追认为有动作）。已知
   * 边界：服务器时钟比客户端慢、学生回到该题后立刻逐题提交时，提交 ts 可能落
   * 在新 focus 之前而追认上一段——该题总时长不变，只是 active / observed 划分偏移。
   */
  const lastClosedByQuestion = new Map<string, Segment[]>();
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
    const closed = episode.pieces.map(
      (piece): Segment => ({
        ...piece,
        questionId: episode.questionId,
        active: episode.active,
        session,
      }),
    );
    segments.push(...closed);
    lastClosedByQuestion.set(episode.questionId, closed);
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
        break; // 前置筛选已确定全卷截止；更早的提交意图仅结束当次聚焦
      default:
        if (
          questionId !== null &&
          QUESTION_ACTIVITY_ACTION_TYPES.has(event.type)
        ) {
          tallyOf(questionId).actions += 1;
          if (state.episode !== null && focused === questionId) {
            state.episode.active = true;
            if (state.idle && event.serverRecorded !== true) {
              // 有动作就不是空闲：队列的 idle_end 可能晚到，这里先恢复计时
              state.idle = false;
              resume(at);
            }
            break;
          }
          const lastClosed =
            event.serverRecorded === true
              ? lastClosedByQuestion.get(questionId)
              : undefined;
          if (event.serverRecorded === true) {
            tallyOf(questionId).viewed = true;
            for (const segment of lastClosed ?? []) segment.active = true;
            break;
          }
          // 没聚焦就有动作（焦点事件丢失 / 旧客户端）：动作本身就是归属依据
          open(questionId, at, true);
        }
    }
  }
  const last = ordered.findLast((event) => event.serverRecorded !== true);
  if (last !== undefined) close(last.clientTs);
  return segments;
}

/** 多会话扫描线：按基本区间归属；返回未归属毫秒与同时在前台的会话数峰值 */
function attribute(
  segments: readonly Segment[],
  tallies: Map<string, Tally>,
): { unattributedMs: number; concurrentSessionsMax: number } {
  const points = [...new Set(segments.flatMap((s) => [s.start, s.end]))].sort(
    (a, b) => a - b,
  );
  const byStart = [...segments].sort((a, b) => a.start - b.start);
  let unattributedMs = 0;
  let concurrentSessionsMax = 1;
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
    concurrentSessionsMax = Math.max(
      concurrentSessionsMax,
      new Set(live.map((s) => s.session)).size,
    );
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
  return { unattributedMs, concurrentSessionsMax };
}

/**
 * 服务端直记的动作事件（SERVER_RECORDED_ACTION_TYPES：服务器时钟、没有会话
 * 标识）归入「最近聚焦该题」的会话：取各会话里该题 question_focus 与该时刻最
 * 接近的一次（之前的优先；没有则取之后最近的）。没有任何会话聚焦过该题 → 原样
 * 留在缺省组（按「没聚焦直接动作」规则归属）。已知边界：只看 focus 不看 blur
 * ——多端同时聚焦过同一题时可能归到较晚 focus 过但已切走的那一端（v1 接受）。
 */
function adoptServerRecordedActions(
  ordered: readonly ActivityEvent[],
): ReplayEvent[] {
  const focusesByQuestion = new Map<string, ActivityEvent[]>();
  for (const event of ordered) {
    if (event.type === "question_focus" && event.questionId !== null) {
      const list = focusesByQuestion.get(event.questionId);
      if (list === undefined) focusesByQuestion.set(event.questionId, [event]);
      else list.push(event);
    }
  }
  return ordered
    .map((event): ReplayEvent => {
      if (
        !SERVER_RECORDED_ACTION_TYPES.has(event.type) ||
        event.viewId !== null ||
        event.questionId === null
      ) {
        return event;
      }
      const marked: ReplayEvent = { ...event, serverRecorded: true };
      const focuses = focusesByQuestion.get(event.questionId);
      if (focuses === undefined) return marked;
      const before = focuses.filter((f) => f.clientTs <= event.clientTs);
      const nearest =
        before[before.length - 1] ??
        focuses.find((f) => f.clientTs > event.clientTs);
      return nearest === undefined
        ? marked
        : {
            ...marked,
            viewId: nearest.viewId,
            // 服务端时钟偏慢时仍先回放客户端 focus，再标记这段有动作。
            clientTs: Math.max(nearest.clientTs, event.clientTs),
          };
    })
    .sort(
      (a, b) =>
        a.clientTs - b.clientTs ||
        Number(a.serverRecorded === true) - Number(b.serverRecorded === true),
    );
}

function serverTsMsOf(event: ActivityEvent): number | null {
  if (event.serverTs === undefined || event.serverTs === null) return null;
  const ms = Date.parse(event.serverTs);
  return Number.isNaN(ms) ? null : ms;
}

export interface ComputeAttemptActivityOptions {
  /** 服务端受理交卷的时刻（attempts.submitted_at，UTC ISO）；未交 / 不知道为 null */
  readonly submittedAt?: string | null;
}

/** 事件序列 → 题内活动用时（纯函数；输入可乱序、可含重复） */
export function computeAttemptActivity(
  input: readonly ActivityEvent[],
  options: ComputeAttemptActivityOptions = {},
): AttemptActivity {
  const submittedAtMs = Date.parse(options.submittedAt ?? "");
  const seen = new Set<string>();
  const deduped = [...input]
    .sort((a, b) => a.clientTs - b.clientTs)
    .filter((event) => {
      // 先判断是否在交卷前收到，再去重，迟到的重复记录不能盖掉原记录。
      const arrived = serverTsMsOf(event);
      if (arrived !== null && arrived > submittedAtMs) return false;
      const key = eventKey(event);
      if (seen.has(key)) return false; // 离线补发 / 双发去重
      seen.add(key);
      return true;
    });
  // 客户端时钟在不同设备间不可比。有服务端交卷时刻时，用同一服务端时钟
  // 截止所有会话；服务器之后收到的补发仍可入事件表，但不改变已交卷统计。
  const cutoff = Number.isNaN(submittedAtMs)
    ? deduped.find((event) => event.type === "submit")?.clientTs
    : undefined;
  const inScope =
    cutoff === undefined
      ? deduped
      : deduped.filter((event) => event.clientTs <= cutoff);
  const ordered = adoptServerRecordedActions(inScope);
  const sessions = new Map<string, ReplayEvent[]>();
  for (const event of ordered) {
    const key = event.viewId ?? "";
    const list = sessions.get(key);
    if (list === undefined) sessions.set(key, [event]);
    else list.push(event);
  }
  const tallies = new Map<string, Tally>();
  const segments: Segment[] = [];
  for (const [session, list] of sessions) {
    segments.push(...replaySession(session, list, tallies));
  }
  const { unattributedMs, concurrentSessionsMax } = attribute(
    segments,
    tallies,
  );

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
    concurrentSessionsMax,
  };
}

/**
 * 结果视图投影：读该 attempt 全部事件（type / clientTs / serverTs / questionId +
 * payload 顶层 viewId，用 json_extract 不逐行 parse）现算；没有任何事件 → 不携带键。
 * submittedAt = attempts.submitted_at（交卷截止锚点；未交为 null）。
 */
export function attemptActivityProjection(
  db: Db,
  attemptId: string,
  submittedAt: string | null,
): { activity: AttemptActivity } | Record<string, never> {
  const rows = db
    .select({
      type: events.type,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      questionId: events.questionId,
      eventOrder: sql<number>`rowid`,
      confirmed: sql<number>`CASE WHEN ${events.type} = 'submit' AND json_valid(${events.payloadJson}) THEN json_extract(${events.payloadJson}, '$.confirmed') ELSE 0 END`,
      viewId: sql<
        string | null
      >`json_extract(${events.payloadJson}, '$.viewId')`,
    })
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .orderBy(asc(events.clientTs), asc(events.id))
    .all();
  const confirmed = rows.find((row) => row.confirmed === 1);
  const activityRows = rows.filter(
    (row) =>
      row.type !== "submit" &&
      (!confirmed || row.eventOrder < confirmed.eventOrder),
  );
  if (activityRows.length === 0) return {};
  return {
    activity: computeAttemptActivity(activityRows, {
      submittedAt: confirmed ? null : submittedAt,
    }),
  };
}
