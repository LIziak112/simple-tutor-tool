import { QUESTION_ACTIVITY_ACTION_TYPES } from "@tutor/contract";
import type { ActivityEvent } from "./question-activity";

/** 回放用事件：adoptServerRecordedActions 给服务端直记事件打标 */
export interface ReplayEvent extends ActivityEvent {
  readonly serverRecorded?: boolean;
  /** 新账按receipt选择的focus身份；旧动态回放不传。 */
  readonly episodeId?: number;
}

export interface Segment {
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

export interface Tally {
  activeMs: number;
  observedMs: number;
  actions: number;
  viewed: boolean;
}

/** 单会话回放：事件已按 clientTs 升序；返回片段并累计 actions / viewed */
export function replaySession(
  session: string,
  ordered: readonly ReplayEvent[],
  tallies: Map<string, Tally>,
): Segment[] {
  const segments: Segment[] = [];
  const evidenceEpisodes = new Map<
    number,
    { episode: Episode; closed: Segment[] }
  >();
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
    for (const item of evidenceEpisodes.values())
      if (item.episode === episode) item.closed = closed;
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
        if (questionId === null) break;
        if (focused !== questionId) open(questionId, at, false);
        if (event.episodeId !== undefined && state.episode)
          evidenceEpisodes.set(event.episodeId, {
            episode: state.episode,
            closed: [],
          });
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
          if (event.serverRecorded === true && event.episodeId !== undefined) {
            const target = evidenceEpisodes.get(event.episodeId);
            if (target) {
              target.episode.active = true;
              for (const segment of target.closed) segment.active = true;
            }
            break;
          }
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
