import { type RefObject, useEffect, useRef } from "react";
import { useAnnotationSessionRef } from "@/features/annotation/use-annotation-record";

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
) {
  const session = useAnnotationSessionRef();
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
    const headerHeight = () =>
      document
        .querySelector('[data-slot="attempt-header"]')
        ?.getBoundingClientRect().height ?? 64;
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
      const header = headerHeight();
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
        headerHeight(),
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
            headerHeight() -
            saved.offset,
        ),
        behavior: "instant",
      });
      onCurrent(saved.questionId);
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
  }, [key, cards, onCurrent, attemptId]);
}
