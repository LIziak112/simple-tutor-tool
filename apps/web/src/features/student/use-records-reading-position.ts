import { useEffect } from "react";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { recordsReturnTarget } from "./record-review-navigation";

/** 只存列表定位ID，不保存答案；按学生和筛选分页隔离。 */
export function useRecordsReadingPosition(
  search: URLSearchParams,
  ready: boolean,
) {
  const session = useNoteSessionRef();
  const key = session
    ? `records-reading:${JSON.stringify([session.origin, session.studentId, recordsReturnTarget(`/s/records?${search}`)])}`
    : null;
  useEffect(() => {
    if (!ready || !key) return;
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(key);
    } catch {
      return;
    }
    if (!id) return;
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const event of events)
      window.addEventListener(event, interrupt, { once: true, passive: true });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (interrupted) return;
        const link = [
          ...document.querySelectorAll<HTMLElement>("[data-record-attempt]"),
        ].find((element) => element.dataset.recordAttempt === id);
        link?.scrollIntoView?.({ block: "center", behavior: "instant" });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const event of events) window.removeEventListener(event, interrupt);
    };
  }, [ready, key]);
  return (id: string) => {
    if (!key) return;
    try {
      sessionStorage.setItem(key, id);
    } catch {
      /* 不阻断打开记录。 */
    }
  };
}
