import {
  buildOfflineIntervals,
  intersectIntervals,
  mergeIntervals,
  msToSec,
  orderTraceEvents,
  subtractIntervals,
  totalIntervalMs,
  TRACE_GAP_CAP_MS,
  type Interval,
  type TraceEvent,
} from "./trace-intervals";

/**
 * 学生 × 题（attempt 域）派生指标（T4.0b，方案 §4.4.1；纯函数、原始 events
 * 不出库、不建新表回写 D13）。T4.1 学情聚合 / T4.3 AI 数据包的唯一消费口。
 *
 * 输入是 attempt 的事件序列（TraceEvent 投影）+ **外部传入的 activeSec**
 * （由既有 computePerQuestionActiveSec 计算——分母用权威口径，本模块零漂移；
 * 既有 11 种事件语义与 activeSec 计算不在本模块触碰）。
 *
 * 时钟纪律（§2.6-3 / §5.0-D15）：
 * - **hint_open（服务端直记，clientTs 是服务端时钟）绝不参与任何区间运算**——
 *   timeToFirstHintSec / hintDwellSec 只用 directive_interact{host:question}
 *   的客户端事件（与 hint_open 按 (questionId, index) 配对是消费方的事）；
 * - 交卷（首个 submit）是除 reviewedSolution 外全部指标的截止事件。
 */

/** 单题的过程指标（全部为行为信号，仅标记不下结论，§4.4.3） */
export interface QuestionTraceMetrics {
  /** 首次 hint open − 首次 question_focus（秒）；未用提示 / 无聚焦记录为 null */
  readonly timeToFirstHintSec: number | null;
  /** 每条提示 open→close（或→blur/隐藏/交卷）累加（秒，区间并集防重叠双计） */
  readonly hintDwellSec: number;
  /** Σ erase+undo+redo+clear（load 不产生 ink_edit_batch，天然排除） */
  readonly inkEditCount: number;
  /** 存在 ink_fullscreen{on:true} */
  readonly fullscreenUsed: boolean;
  /** net_offline 区间 ∩ focus 区间 ÷ activeSec ∈ [0,1]；activeSec=0 时 0 */
  readonly offlineShare: number;
  /** 交卷后存在 directive_interact{host:result, solution, open}（该题） */
  readonly reviewedSolution: boolean;
}

/** 中间账本（输出前收口成 QuestionTraceMetrics） */
interface QuestionAccumulator {
  firstFocusTs: number | null;
  firstHintOpenTs: number | null;
  hintOpenTs: number[];
  inkEditCount: number;
  fullscreenUsed: boolean;
  reviewedSolution: boolean;
}

function newAccumulator(): QuestionAccumulator {
  return {
    firstFocusTs: null,
    firstHintOpenTs: null,
    hintOpenTs: [],
    inkEditCount: 0,
    fullscreenUsed: false,
    reviewedSolution: false,
  };
}

/** host=question/result 的 directive_interact 收窄（payload 摊平字段判别） */
function isDirectiveInteract(
  event: TraceEvent,
  host: string,
  name?: string,
  action?: string,
): boolean {
  return (
    event.type === "directive_interact" &&
    event.host === host &&
    (name === undefined || event.name === name) &&
    (action === undefined || event.action === action)
  );
}

/**
 * 按题的 focus 区间（offlineShare 的分子用）：focus→blur / 隐式切换（另一题
 * focus）/ submit 截止；page_hidden→page_visible 期间扣除（与 activeSec 同语义
 * 的简化复算——只求交集足够，不做取整）。未闭合 focus 收尾 = 流内最后事件与
 * 30 分钟硬上限的较小者。
 */
function focusIntervalsByQuestion(
  ordered: readonly TraceEvent[],
): Map<string, Interval[]> {
  const out = new Map<string, Interval[]>();
  const hidden = new Map<string, Interval[]>();
  let hiddenStart: number | null = null;
  let openQuestion: string | null = null;
  let openStart: number | null = null;
  let lastTs: number | null = null;

  const closeOpen = (atTs: number): void => {
    if (openQuestion === null || openStart === null) return;
    if (atTs > openStart) {
      const list = out.get(openQuestion) ?? [];
      list.push({ start: openStart, end: atTs });
      out.set(openQuestion, list);
    }
    openQuestion = null;
    openStart = null;
  };

  for (const event of ordered) {
    lastTs = event.clientTs;
    switch (event.type) {
      case "question_focus": {
        const q = event.questionId;
        if (q === undefined) break;
        if (openQuestion === q) break; // 重复 focus 同题：忽略（active-time 规则 5）
        closeOpen(event.clientTs); // 隐式结算前一题（规则 4）
        openQuestion = q;
        openStart = event.clientTs;
        out.set(q, out.get(q) ?? []);
        break;
      }
      case "question_blur": {
        if (openQuestion !== null && event.questionId === openQuestion) {
          closeOpen(event.clientTs);
        }
        break;
      }
      case "page_hidden": {
        if (hiddenStart === null) hiddenStart = event.clientTs;
        break;
      }
      case "page_visible": {
        if (hiddenStart !== null) {
          if (event.clientTs > hiddenStart && openQuestion !== null) {
            const list = hidden.get(openQuestion) ?? [];
            list.push({ start: hiddenStart, end: event.clientTs });
            hidden.set(openQuestion, list);
          }
          hiddenStart = null;
        }
        break;
      }
      case "submit": {
        closeOpen(event.clientTs);
        break;
      }
      default:
        break;
    }
  }
  // 序列结束仍聚焦：计到最后事件（规则 7 同款兜底，证据终点）
  if (openQuestion !== null && openStart !== null && lastTs !== null) {
    const end = Math.min(lastTs, openStart + TRACE_GAP_CAP_MS);
    if (end > openStart) {
      const list = out.get(openQuestion) ?? [];
      list.push({ start: openStart, end });
      out.set(openQuestion, list);
    }
  }
  // hidden 区间配对收尾：未闭合的 hidden 记到流末（保守：hidden 之后不再计 focus）
  if (hiddenStart !== null && lastTs !== null && openQuestion !== null) {
    const list = hidden.get(openQuestion) ?? [];
    list.push({ start: hiddenStart, end: lastTs });
    hidden.set(openQuestion, list);
  }
  // focus − hidden
  const result = new Map<string, Interval[]>();
  for (const [q, intervals] of out) {
    result.set(q, subtractIntervals(intervals, hidden.get(q) ?? []));
  }
  return result;
}

/**
 * 计算一 attempt 的全部学生×题过程指标。
 * @param events 该 attempt 的全部事件（TraceEvent 投影，含 payload 摊平字段；
 *   hint_open 行可以传入但不会被任何区间运算读取）
 * @param activeSecByQuestion computePerQuestionActiveSec 的权威结果（秒）
 */
export function computeAttemptTraceMetrics(
  events: readonly TraceEvent[],
  activeSecByQuestion: Readonly<Record<string, number>>,
): Record<string, QuestionTraceMetrics> {
  const ordered = orderTraceEvents(events);
  const submitEvent = ordered.find((e) => e.type === "submit");
  const submitTs = submitEvent?.clientTs ?? null;

  const accounts = new Map<string, QuestionAccumulator>();
  const accountOf = (questionId: string): QuestionAccumulator => {
    let acc = accounts.get(questionId);
    if (acc === undefined) {
      acc = newAccumulator();
      accounts.set(questionId, acc);
    }
    return acc;
  };

  for (const event of ordered) {
    switch (event.type) {
      case "question_focus": {
        const q = event.questionId;
        if (q === undefined) break;
        const acc = accountOf(q);
        if (acc.firstFocusTs === null) acc.firstFocusTs = event.clientTs;
        break;
      }
      case "directive_interact": {
        const q = event.questionId;
        if (q === undefined) break;
        if (isDirectiveInteract(event, "question", "hint", "open")) {
          // 交卷后的迟到事件不进指标（submit 截止语义）
          if (submitTs !== null && event.clientTs > submitTs) break;
          const acc = accountOf(q);
          acc.hintOpenTs.push(event.clientTs);
          if (acc.firstHintOpenTs === null) acc.firstHintOpenTs = event.clientTs;
        } else if (isDirectiveInteract(event, "result", "solution", "open")) {
          // 交卷后才算复盘（无 submit 事件的异常流按存在即算——结果页只在
          // 交卷后存在，缺 submit 属于事件丢失而非时序问题）
          const acc = accountOf(q);
          if (submitTs === null || event.clientTs > submitTs) {
            acc.reviewedSolution = true;
          }
        } else if (
          isDirectiveInteract(event, "result") ||
          isDirectiveInteract(event, "question")
        ) {
          accountOf(q); // 出现过即立户（close 等负向事件不留指标但占位）
        }
        break;
      }
      case "ink_edit_batch": {
        const q = event.questionId;
        if (q === undefined) break;
        const acc = accountOf(q);
        acc.inkEditCount +=
          (event.erase ?? 0) + (event.undo ?? 0) + (event.redo ?? 0) + (event.clear ?? 0);
        break;
      }
      case "ink_fullscreen": {
        const q = event.questionId;
        if (q === undefined) break;
        const acc = accountOf(q);
        if (event.on === true) acc.fullscreenUsed = true;
        break;
      }
      default:
        break;
    }
  }

  // 区间类：offlineShare 分子、hintDwell
  const focusByQuestion = focusIntervalsByQuestion(ordered);
  const offline = buildOfflineIntervals(ordered);

  // hintDwell 边界事件序列（blur/hidden/submit）
  const result: Record<string, QuestionTraceMetrics> = {};
  for (const [q, acc] of accounts) {
    // timeToFirstHintSec
    let timeToFirstHintSec: number | null = null;
    if (acc.firstHintOpenTs !== null && acc.firstFocusTs !== null) {
      timeToFirstHintSec = msToSec(acc.firstHintOpenTs - acc.firstFocusTs);
    }

    // hintDwellSec：每个 open 的区间 [open, 边界)，边界 = open 之后最早的
    // question_blur(q) / page_hidden / submit（或 open+30 分钟硬上限）
    const boundaries = ordered
      .filter(
        (e) =>
          (e.type === "question_blur" && e.questionId === q) ||
          e.type === "page_hidden" ||
          e.type === "submit",
      )
      .map((e) => e.clientTs);
    const hintIntervals: Interval[] = [];
    for (const openTs of acc.hintOpenTs) {
      let end = openTs + TRACE_GAP_CAP_MS;
      for (const b of boundaries) {
        if (b > openTs && b < end) {
          end = b;
          break;
        }
      }
      if (end > openTs) hintIntervals.push({ start: openTs, end });
    }
    const hintDwellSec = msToSec(totalIntervalMs(mergeIntervals(hintIntervals)));

    // offlineShare：|offline ∩ focus| ÷ (activeSec × 1000)
    const activeMs = (activeSecByQuestion[q] ?? 0) * 1000;
    let offlineShare = 0;
    if (activeMs > 0) {
      const overlapMs = totalIntervalMs(
        intersectIntervals(focusByQuestion.get(q) ?? [], offline),
      );
      offlineShare = Math.min(1, overlapMs / activeMs);
    }

    result[q] = {
      timeToFirstHintSec,
      hintDwellSec,
      inkEditCount: acc.inkEditCount,
      fullscreenUsed: acc.fullscreenUsed,
      offlineShare,
      reviewedSolution: acc.reviewedSolution,
    };
  }
  return result;
}
