import { type RefObject, useEffect, useRef } from "react";
import { useAnnotationSessionRef } from "@/features/annotation/use-annotation-record";

function headerHeightOf(): number {
  return (
    document
      .querySelector('[data-slot="attempt-header"]')
      ?.getBoundingClientRect().height ?? 64
  );
}

type ReadingPosition = { questionId: string; offset: number };
const INTERRUPT_EVENTS = [
  "wheel",
  "touchstart",
  "pointerdown",
  "keydown",
] as const;

function readPosition(key: string | null): ReadingPosition | null {
  if (key === null) return null;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "questionId" in raw &&
      typeof raw.questionId === "string" &&
      "offset" in raw &&
      typeof raw.offset === "number" &&
      Number.isFinite(raw.offset)
    )
      return { questionId: raw.questionId, offset: raw.offset };
  } catch {
    // 阅读位置不是答案；存储不可用时不阻断作答。
  }
  return null;
}

/** 等待布局稳定后恢复一次；用户先操作时让用户接管，绝不延迟抢滚动。 */
export function useReadingPosition(
  attemptId: string,
  cards: RefObject<Map<string, HTMLLIElement>>,
  onCurrent: (id: string) => void,
  /**
   * 请求立即挂载某题（题卡视口懒挂载，2026-10-28）：恢复目标题常常不在
   * 视口附近、尚未挂载，此时不能放弃恢复，而要强制挂载后再对齐。
   */
  requestMount: (questionId: string) => void,
  /**
   * 题卡挂载版本号（懒挂载捕获补丁，2026-10-28）：挂载把占位换成真实高度，
   * 布局平移不产生 scroll 事件，捕获只在版本变化后重跑一次（见下）。
   */
  cardMountVersion: number,
) {
  const session = useAnnotationSessionRef();
  const captureRef = useRef<((save: boolean) => void) | null>(null);
  const alignedRef = useRef<ReadingPosition | null>(null);
  const interaction = useRef({ attemptId, started: false });
  const key =
    session === null
      ? null
      : `attempt-reading:${JSON.stringify([session.origin, session.studentId, attemptId])}`;
  useEffect(() => {
    if (interaction.current.attemptId !== attemptId)
      interaction.current = { attemptId, started: false };
    let pending = interaction.current.started ? null : readPosition(key);
    let latest: ReadingPosition | null = null;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      clearTimeout(saveTimer);
      if (key === null || latest === null) return;
      try {
        localStorage.setItem(key, JSON.stringify(latest));
      } catch {
        // 只降级阅读恢复，不影响答案和草稿保存。
      }
    };
    const capture = (save: boolean) => {
      frame = 0;
      const header = headerHeightOf();
      let best: ReadingPosition | null = null;
      let distance = Infinity;
      for (const [id, element] of cards.current) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= header || rect.top >= window.innerHeight) continue;
        const next = Math.abs(rect.top - header - 12);
        if (next < distance) {
          best = { questionId: id, offset: rect.top - header };
          distance = next;
        }
      }
      if (best === null) return;
      onCurrent(best.questionId);
      if (save && pending === null) {
        latest = best;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 200);
      }
    };
    captureRef.current = capture;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => capture(true));
    };
    const onPageHide = () => {
      cancelAnimationFrame(frame);
      if (pending === null) capture(true);
      persist();
    };
    const interrupt = () => {
      interaction.current.started = true;
      alignedRef.current = null;
      if (pending === null) return;
      pending = null;
      clearTimeout(restoreTimer);
      capture(true);
    };
    const deadline = performance.now() + 5000;
    let previous = "";
    let stable = 0;
    const tryRestore = () => {
      if (pending === null) return;
      if (performance.now() >= deadline) {
        pending = null;
        capture(false);
        return;
      }
      const preceding: HTMLLIElement[] = [];
      let target: HTMLLIElement | undefined;
      for (const [id, element] of cards.current) {
        preceding.push(element);
        if (id === pending.questionId) {
          target = element;
          break;
        }
      }
      if (target === undefined) {
        // 目标题还没挂载：请求强制挂载并继续等（懒挂载前这里直接放弃恢复，
        // 学生会回到顶部而不是上次读到的位置）。
        requestMount(pending.questionId);
        if (performance.now() < deadline) {
          restoreTimer = setTimeout(tryRestore, 100);
          return;
        }
        pending = null;
        capture(false);
        return;
      }
      const ready =
        document.fonts?.status !== "loading" &&
        preceding.every(
          (element) =>
            !element.querySelector(
              '[data-slot="question-surface"] [role="status"]',
            ) &&
            [...element.querySelectorAll("img")].every(
              (image) => image.complete,
            ),
        );
      const geometry = JSON.stringify([
        headerHeightOf(),
        ...preceding.map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.top, rect.width, rect.height];
        }),
      ]);
      stable = ready && geometry === previous ? stable + 1 : 0;
      previous = geometry;
      if (stable < 3) {
        restoreTimer = setTimeout(tryRestore, 100);
        return;
      }
      const saved = pending;
      pending = null;
      window.scrollTo({
        top: Math.max(
          0,
          window.scrollY +
            target.getBoundingClientRect().top -
            headerHeightOf() -
            saved.offset,
        ),
        behavior: "instant",
      });
      onCurrent(saved.questionId);
      // 对齐本身会把沿途卡片带入挂载区、内容再膨胀（实测 510px）：登记本次
      // 对齐，挂载版本变化后的重对齐把这次平移兜住（无用户操作期间）。
      alignedRef.current = saved;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    for (const event of INTERRUPT_EVENTS)
      window.addEventListener(event, interrupt, { passive: true });
    capture(pending === null);
    if (pending !== null) restoreTimer = setTimeout(tryRestore, 100);
    return () => {
      pending = null;
      clearTimeout(restoreTimer);
      cancelAnimationFrame(frame);
      persist();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      for (const event of INTERRUPT_EVENTS)
        window.removeEventListener(event, interrupt);
    };
  }, [key, cards, onCurrent, attemptId, requestMount]);
  // 懒挂载引发的布局位移没有 scroll 事件：挂载版本变化（rAF 合帧）后等
  // 布局 settle 再重捕一次；restore 进行中由 capture 的 pending 守卫挡住。
  useEffect(() => {
    if (cardMountVersion === 0) return;
    const timer = setTimeout(() => {
      const aligned = alignedRef.current;
      if (aligned !== null) {
        const element = cards.current.get(aligned.questionId);
        if (element === undefined) {
          alignedRef.current = null;
        } else {
          const deviation =
            element.getBoundingClientRect().top -
            headerHeightOf() -
            aligned.offset;
          if (Math.abs(deviation) > 4) {
            window.scrollTo({
              top: window.scrollY + deviation,
              behavior: "instant",
            });
          }
        }
      }
      captureRef.current?.(true);
    }, 150);
    return () => clearTimeout(timer);
  }, [cardMountVersion]);
}
