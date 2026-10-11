import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { type ReviewScope, reviewScopes } from "./result-review-model";

export function normalizeReviewLocation(
  params: URLSearchParams,
  ids: readonly string[],
  released: boolean,
) {
  const scope =
    reviewScopes(released).find(
      (value) => value === params.get("reviewScope"),
    ) ?? "all";
  const requested = params.get("reviewQuestion");
  return {
    scope,
    questionId:
      requested && ids.includes(requested) ? requested : (ids[0] ?? null),
  };
}

/** 回看只保存位置，不复用未交卷答案仓或草稿阅读键。 */
export function useResultReviewLocation(
  attemptId: string,
  ids: readonly string[],
  released: boolean,
  root: RefObject<HTMLElement | null>,
) {
  const [params, setParams] = useSearchParams();
  const session = useNoteSessionRef();
  const key = session
    ? `result-reading:${JSON.stringify([session.origin, session.studentId, attemptId])}`
    : null;
  const normalized = useMemo(
    () => normalizeReviewLocation(params, ids, released),
    [params, ids, released],
  );
  const [currentId, setCurrentId] = useState(normalized.questionId);
  const interacted = useRef(false);
  const jumpToElement = useCallback(
    (id: string, focus: boolean) => {
      const element = [
        ...(root.current?.querySelectorAll<HTMLElement>(
          "[data-review-question]",
        ) ?? []),
      ].find((card) => card.dataset.reviewQuestion === id);
      element?.scrollIntoView?.({ block: "start", behavior: "instant" });
      if (focus)
        element
          ?.querySelector<HTMLElement>("[data-review-heading]")
          ?.focus({ preventScroll: true });
      setCurrentId(id);
    },
    [root],
  );
  const jump = useCallback(
    (id: string) => {
      if (!ids.includes(id)) return;
      interacted.current = true;
      const next = new URLSearchParams(params);
      next.set("reviewQuestion", id);
      setParams(next, { replace: true, preventScrollReset: true });
      jumpToElement(id, true);
    },
    [ids, params, setParams, jumpToElement],
  );
  const setScope = (scope: ReviewScope) => {
    const next = new URLSearchParams(params);
    next.set(
      "reviewScope",
      reviewScopes(released).includes(scope) ? scope : "all",
    );
    setParams(next, { replace: true, preventScrollReset: true });
  };
  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    const interrupt = () => {
      interacted.current = true;
    };
    window.addEventListener("pointerdown", interrupt, { once: true });
    window.addEventListener("keydown", interrupt, { once: true });
    window.addEventListener("wheel", interrupt, { once: true, passive: true });
    window.addEventListener("touchstart", interrupt, {
      once: true,
      passive: true,
    });
    let id = params.has("reviewQuestion") ? normalized.questionId : null;
    if (!params.has("reviewQuestion") && key) {
      try {
        const stored = sessionStorage.getItem(key);
        if (stored && ids.includes(stored)) id = stored;
      } catch {
        /* 阅读恢复失败不阻断回看。 */
      }
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!cancelled && !interacted.current && id) jumpToElement(id, false);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", interrupt);
      window.removeEventListener("keydown", interrupt);
      window.removeEventListener("wheel", interrupt);
      window.removeEventListener("touchstart", interrupt);
    };
  }, [key, ids, params, normalized.questionId, jumpToElement]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<HTMLElement>();
    const header = root.current
      ?.closest('[data-slot="attempt-workspace"]')
      ?.querySelector('[data-slot="attempt-header"]');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        const closest = [...visible].sort(
          (a, b) =>
            Math.abs(
              a.getBoundingClientRect().top -
                (header?.getBoundingClientRect().bottom ?? 96),
            ) -
            Math.abs(
              b.getBoundingClientRect().top -
                (header?.getBoundingClientRect().bottom ?? 96),
            ),
        )[0];
        if (closest?.dataset.reviewQuestion)
          setCurrentId(closest.dataset.reviewQuestion);
      },
      { rootMargin: "-96px 0px -35% 0px", threshold: [0, 0.1] },
    );
    for (const card of root.current?.querySelectorAll<HTMLElement>(
      "[data-review-question]",
    ) ?? [])
      if (
        card.dataset.reviewQuestion &&
        ids.includes(card.dataset.reviewQuestion)
      )
        observer.observe(card);
    return () => observer.disconnect();
  }, [root, ids]);
  useEffect(() => {
    if (!key || !currentId) return;
    try {
      sessionStorage.setItem(key, currentId);
    } catch {
      /* 不存答案，仅降级阅读恢复。 */
    }
  }, [key, currentId]);
  return { currentId, scope: normalized.scope, jump, setScope };
}
