import type {
  TeacherAttemptReplayData,
  TeacherAttemptReplayEvent,
} from "@tutor/contract";

/**
 * 做题复现纯函数模型（hall-15077）：
 * - 输入 replay 载荷（契约 teacherAttemptReplayDataSchema 的 data），输出任意
 *   时刻 T 的做题状态快照；UI（AttemptReplay）只消费本模型，不自行解析。
 * - 事件按 clientTs 升序消费（服务端已排序）：answer_change 取 payload.from/to
 *   （学生自己的输入值）、question_focus/blur 维护「当前聚焦题」、page_hidden/
 *   visible + net_offline/online + idle_start/end 维护全局三态、ink_stroke_batch
 *   累加每题笔画、hint_open 计提示解锁、question_submit 记逐题提交时刻。
 * - 草稿/手写/逐题提交三类服务端事实按 ISO 换算成毫秒定位，并对窗口两端钳制：
 *   早于窗口起点的在 T=起点即成立，晚于终点的最晚在 T=终点成立。
 * - 前向兼容：未知事件类型一律忽略（采集侧新增事件零改动，复现视图不动）。
 */

/** 单题在 T 时刻的状态 */
export interface ReplayQuestionState {
  questionId: string;
  /** 最后一次 answer_change 的 to 值（学生输入原样；无作答为 null） */
  lastAnswer: unknown;
  /** answer_change 次数 */
  answerChanges: number;
  /** 已解锁提示数 */
  hintsOpened: number;
  /** 已上报笔画数（ink_stroke_batch 累加） */
  strokes: number;
  /** 手写上传的权威状态：最近一次覆盖的 revision（无上传为 null） */
  inkRevision: number | null;
  /** 手写上传时的服务端笔画数（无上传为 null） */
  inkStrokeCount: number | null;
  /** 草稿已确认版本数（≤ 该题 noteVersions 总数） */
  draftRevisions: number;
  /** 最近草稿版本号（无草稿为 null） */
  draftRevision: number | null;
  /** 逐题提交时刻（epoch ms；未提交为 null） */
  submittedAtMs: number | null;
  /** 是否曾聚焦过本题 */
  focused: boolean;
}

/** 时刻 T 的整卷复现状态 */
export interface ReplayState {
  tMs: number;
  /** 当前聚焦题（最近交互；无聚焦为 null） */
  focusQuestionId: string | null;
  pageHidden: boolean;
  offline: boolean;
  idle: boolean;
  questions: Map<string, ReplayQuestionState>;
  /** 已消费的事件数（含被忽略的未知类型） */
  consumedEvents: number;
}

/** 复现窗口（epoch ms）；无任何事实为 null */
export function replayWindow(
  data: TeacherAttemptReplayData,
): { startMs: number; endMs: number } | null {
  if (data.windowStartMs === null || data.windowEndMs === null) return null;
  return { startMs: data.windowStartMs, endMs: data.windowEndMs };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function clamp(ms: number, startMs: number, endMs: number): number {
  return Math.min(Math.max(ms, startMs), endMs);
}

/** 三类服务端事实的统一形状：换算后的毫秒时刻 + 定位到的题目 */
interface ReplayFact {
  atMs: number;
  questionId: string;
  kind: "draft" | "ink" | "submit";
  revision: number;
  /** ink 事实携带上传时服务端笔画数；draft/submit 为 0 */
  strokes: number;
}

function factsOf(
  data: TeacherAttemptReplayData,
  startMs: number,
  endMs: number,
): ReplayFact[] {
  const facts: ReplayFact[] = [];
  for (const note of data.noteVersions) {
    const at = isoToMs(note.savedAt);
    if (Number.isNaN(at)) continue;
    facts.push({
      atMs: clamp(at, startMs, endMs),
      questionId: note.questionId,
      kind: "draft",
      revision: note.revision,
      strokes: 0,
    });
  }
  for (const inkPoint of data.inkPoints) {
    const at = isoToMs(inkPoint.updatedAt);
    if (Number.isNaN(at)) continue;
    facts.push({
      atMs: clamp(at, startMs, endMs),
      questionId: inkPoint.questionId,
      kind: "ink",
      revision: inkPoint.revision,
      strokes: inkPoint.strokeCount,
    });
  }
  for (const submit of data.submitPoints) {
    const at = isoToMs(submit.submittedAt);
    if (Number.isNaN(at)) continue;
    facts.push({
      atMs: clamp(at, startMs, endMs),
      questionId: submit.questionId,
      kind: "submit",
      revision: 0,
      strokes: 0,
    });
  }
  // 同刻排序稳定：draft/ink/submit 按该序生效（事实间无强时序语义）
  facts.sort((a, b) => a.atMs - b.atMs || a.kind.localeCompare(b.kind));
  return facts;
}

function questionStateOf(
  states: Map<string, ReplayQuestionState>,
  questionId: string,
): ReplayQuestionState {
  let state = states.get(questionId);
  if (state === undefined) {
    state = {
      questionId,
      lastAnswer: null,
      answerChanges: 0,
      hintsOpened: 0,
      strokes: 0,
      draftRevisions: 0,
      draftRevision: null,
      inkRevision: null,
      inkStrokeCount: null,
      submittedAtMs: null,
      focused: false,
    };
    states.set(questionId, state);
  }
  return state;
}

function applyEvent(
  state: ReplayState,
  event: TeacherAttemptReplayEvent,
): void {
  const questionId = event.questionId;
  switch (event.type) {
    case "question_focus": {
      if (questionId === null) return;
      const question = questionStateOf(state.questions, questionId);
      question.focused = true;
      state.focusQuestionId = questionId;
      return;
    }
    case "question_blur": {
      if (questionId !== null && state.focusQuestionId === questionId) {
        state.focusQuestionId = null;
      }
      return;
    }
    case "answer_change": {
      if (questionId === null) return;
      const question = questionStateOf(state.questions, questionId);
      question.answerChanges += 1;
      if ("to" in event.payload) question.lastAnswer = event.payload.to ?? null;
      return;
    }
    case "hint_open": {
      if (questionId === null) return;
      questionStateOf(state.questions, questionId).hintsOpened += 1;
      return;
    }
    case "ink_stroke_batch": {
      if (questionId === null) return;
      const strokes = numberOf(event.payload.strokes);
      if (strokes !== null && strokes > 0) {
        questionStateOf(state.questions, questionId).strokes += strokes;
      }
      return;
    }
    case "question_submit": {
      if (questionId === null) return;
      const question = questionStateOf(state.questions, questionId);
      if (question.submittedAtMs === null)
        question.submittedAtMs = event.clientTs;
      return;
    }
    case "page_hidden":
      state.pageHidden = true;
      return;
    case "page_visible":
      state.pageHidden = false;
      return;
    case "net_offline":
      state.offline = true;
      return;
    case "net_online":
      state.offline = false;
      return;
    case "idle_start":
      state.idle = true;
      return;
    case "idle_end":
      state.idle = false;
      return;
    default:
      // 未知/讲义域类型：消费但不改变状态（前向兼容）
      return;
  }
}

/**
 * 时刻 T 的整卷状态。t 早于窗口起点按起点算、晚于终点按终点算（滑杆两端外
 * 不产生第三种状态）；无任何事实（空窗口）返回 null。
 */
export function replayStateAt(
  data: TeacherAttemptReplayData,
  tMs: number,
): ReplayState | null {
  const window = replayWindow(data);
  if (window === null) return null;
  const t = clamp(tMs, window.startMs, window.endMs);

  const state: ReplayState = {
    tMs: t,
    focusQuestionId: null,
    pageHidden: false,
    offline: false,
    idle: false,
    questions: new Map(),
    consumedEvents: 0,
  };

  // 服务端事实先落（钳制后 ≤ t 的生效），事件流随后叠加：提交时刻等已有
  // 服务端事实的字段以事实为准（先落者胜——事件仅在无事实时补位 clientTs）；
  // 作答/聚焦/环境等纯事件状态与事实字段互补，不互相覆盖
  for (const fact of factsOf(data, window.startMs, window.endMs)) {
    if (fact.atMs > t) continue;
    const question = questionStateOf(state.questions, fact.questionId);
    if (fact.kind === "draft") {
      question.draftRevisions += 1;
      question.draftRevision = fact.revision;
    } else if (fact.kind === "ink") {
      // 同题幂等覆盖：revision 更大者胜（与 ink 上传语义一致）
      if (
        question.inkRevision === null ||
        fact.revision >= question.inkRevision
      ) {
        question.inkRevision = fact.revision;
        question.inkStrokeCount = fact.strokes;
      }
    } else if (question.submittedAtMs === null) {
      question.submittedAtMs = fact.atMs;
    }
  }
  for (const event of data.events) {
    if (event.clientTs > t) break;
    state.consumedEvents += 1;
    applyEvent(state, event);
  }
  return state;
}
