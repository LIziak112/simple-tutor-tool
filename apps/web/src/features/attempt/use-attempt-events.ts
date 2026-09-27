import type { StudentAnswer } from "@tutor/contract";
import { useCallback, useEffect, useRef } from "react";
import { createEventQueue, type EventQueueApi } from "@/lib/event-queue";

/**
 * 答题页学习痕迹埋点（T2.10，§5.5）：
 * - 进入答题页报 attempt_start；卸载/交卷前 blur 当前聚焦题并尽力 flush；
 * - 「当前聚焦题」判定（简版，见任务报告取舍）：
 *   1. 最近交互的题（作答 / 手写）优先——noteInteraction 即 focusTo；
 *   2. 交互过的题离开视口（IntersectionObserver 占比 < 10%）或尚无任何交互时，
 *      切到视口占比最大的题卡（滚动阅读也能正确归时）；
 *   3. focus 切换时自动补发前一题的 question_blur（服务端也按隐式切换兜底）；
 * - question_view：每题首次进入视口报一次；
 * - answer_change：与草稿保存同节奏（防抖/立即提交点回调，onAnswerCommitted），
 *   from 取该题上一次上报值——文本键击天然聚合，changeCount 不虚高；
 * - ink_stroke_batch：每笔结束报当前笔画数（HandwrittenControls onInkStroke）；
 * - page_hidden / page_visible：事件队列内部自动注入（attempt scope）；
 * - submit：finalizeSubmit 在 POST submit 前补 blur + submit 事件并 flush，
 *   确保服务端交卷计算时事件序列已入库（flush 失败不阻塞交卷，宽松口径兜底）。
 *
 * 前端不计算任何汇总值（activeSec 由服务端按原始事件计算，§5.5）。
 */

/** 答题页对外的埋点 API */
export interface AttemptEventsApi {
  /** 学生与某题发生交互（作答/手写展开）→ 聚焦切到该题 */
  noteInteraction(questionId: string): void;
  /** 一次答案保存生效（防抖/立即提交点）→ answer_change 事件（from=上次值） */
  trackAnswerChange(questionId: string, answer: StudentAnswer): void;
  /** 一批手写笔画结束 → ink_stroke_batch 事件 */
  trackInkStrokes(questionId: string, strokes: number): void;
  /** 题卡 DOM 注册（li 元素）：question_view 首次进视口 + 视口兜底聚焦 */
  registerCard(questionId: string, el: HTMLElement | null): void;
  /** 交卷前收尾：blur 当前聚焦 + submit 事件 + flush（尽力，不抛错） */
  finalizeSubmit(): Promise<void>;
}

export function useAttemptEvents(attemptId: string): AttemptEventsApi {
  const queueRef = useRef<EventQueueApi | null>(null);
  /** 当前已上报 question_focus 的题（null=尚未聚焦） */
  const focusedRef = useRef<string | null>(null);
  /** 已报过 question_view 的题（每题一次） */
  const viewedRef = useRef(new Set<string>());
  /** 各题最近一次上报的答案值（answer_change 的 from 来源） */
  const lastAnswerRef = useRef(new Map<string, StudentAnswer>());
  /** 题卡元素注册表（questionId → li） */
  const cardsRef = useRef(new Map<string, HTMLElement>());
  /** 各题当前视口占比（IntersectionObserver 回调维护） */
  const ratiosRef = useRef(new Map<string, number>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const track = useCallback((event: Parameters<EventQueueApi["track"]>[0]) => {
    queueRef.current?.track(event);
  }, []);

  /** 聚焦切换：不同题时补 blur 旧题 + focus 新题（幂等：同题直接返回） */
  const focusTo = useCallback(
    (questionId: string) => {
      if (focusedRef.current === questionId) return;
      const now = Date.now();
      if (focusedRef.current !== null) {
        track({
          type: "question_blur",
          clientTs: now,
          questionId: focusedRef.current,
        });
      }
      track({ type: "question_focus", clientTs: now, questionId });
      focusedRef.current = questionId;
    },
    [track],
  );

  // 队列生命周期：进入报 attempt_start；卸载 blur + dispose（内部尽力 flush）
  useEffect(() => {
    const queue = createEventQueue({
      scope: { kind: "attempt", attemptId },
    });
    queueRef.current = queue;
    focusedRef.current = null;
    viewedRef.current = new Set();
    queue.track({ type: "attempt_start", clientTs: Date.now() });
    return () => {
      if (focusedRef.current !== null) {
        queue.track({
          type: "question_blur",
          clientTs: Date.now(),
          questionId: focusedRef.current,
        });
        focusedRef.current = null;
      }
      queue.dispose();
      queueRef.current = null;
    };
  }, [attemptId]);

  // 视口观察：question_view（每题首次进视口）+ 聚焦题的视口兜底切换。
  // jsdom 等无 IntersectionObserver 的环境自动降级（聚焦只靠交互）。
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const questionId = entry.target.getAttribute("data-question-id");
          if (questionId === null) continue;
          ratiosRef.current.set(questionId, entry.intersectionRatio);
          // 首次进入视口 → question_view（每题一次）
          if (entry.intersectionRatio > 0 && !viewedRef.current.has(questionId)) {
            viewedRef.current.add(questionId);
            track({ type: "question_view", clientTs: Date.now(), questionId });
          }
        }
        // 视口兜底：聚焦题仍占视口 ≥10% 时保持；否则切到占比最大的题
        const current = focusedRef.current;
        const currentRatio =
          current === null ? 0 : (ratiosRef.current.get(current) ?? 0);
        if (current !== null && currentRatio >= 0.1) return;
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const [questionId, ratio] of ratiosRef.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = questionId;
          }
        }
        if (bestId !== null && bestRatio > 0 && bestId !== current) {
          focusTo(bestId);
        }
      },
      { threshold: [0, 0.1, 0.25, 0.5, 1] },
    );
    observerRef.current = observer;
    for (const el of cardsRef.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [attemptId, focusTo, track]);

  const noteInteraction = useCallback(
    (questionId: string) => {
      focusTo(questionId);
    },
    [focusTo],
  );

  const trackAnswerChange = useCallback(
    (questionId: string, answer: StudentAnswer) => {
      const from = lastAnswerRef.current.get(questionId);
      track({
        type: "answer_change",
        clientTs: Date.now(),
        questionId,
        ...(from !== undefined ? { from } : {}),
        to: answer,
      });
      lastAnswerRef.current.set(questionId, answer);
    },
    [track],
  );

  const trackInkStrokes = useCallback(
    (questionId: string, strokes: number) => {
      if (strokes < 1) return; // 清空等空批次不上报（契约 strokes ≥1）
      track({
        type: "ink_stroke_batch",
        clientTs: Date.now(),
        questionId,
        strokes,
      });
    },
    [track],
  );

  const registerCard = useCallback(
    (questionId: string, el: HTMLElement | null) => {
      const prev = cardsRef.current.get(questionId);
      if (prev !== undefined) {
        observerRef.current?.unobserve(prev);
        cardsRef.current.delete(questionId);
        ratiosRef.current.delete(questionId);
      }
      if (el !== null) {
        el.setAttribute("data-question-id", questionId);
        cardsRef.current.set(questionId, el);
        observerRef.current?.observe(el);
      }
    },
    [],
  );

  const finalizeSubmit = useCallback(async () => {
    const queue = queueRef.current;
    if (queue === null) return;
    if (focusedRef.current !== null) {
      queue.track({
        type: "question_blur",
        clientTs: Date.now(),
        questionId: focusedRef.current,
      });
      focusedRef.current = null;
    }
    queue.track({ type: "submit", clientTs: Date.now() });
    try {
      await queue.flush();
    } catch {
      // flush 失败不阻塞交卷（事件留在队列/离线仓，服务端宽松口径收迟到事件）
    }
  }, []);

  return {
    noteInteraction,
    trackAnswerChange,
    trackInkStrokes,
    registerCard,
    finalizeSubmit,
  };
}
