import type { AttemptQuestionPublic } from "@tutor/contract";
import type { AnnotationScope, AnnotationSessionRef } from "./annotation-store";
import {
  cancelQuestionBasePrewarm,
  prewarmQuestionBase,
} from "./question-base-prewarm";

/** 不在交互中生成；不支持可见性观察时保留显式打开路径。 */
export function scheduleQuestionBasePrewarm(
  session: AnnotationSessionRef,
  scope: AnnotationScope,
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  isBusy: () => boolean,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  let alive = true;
  let visible = false;
  let idle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (idle !== null) window.cancelIdleCallback(idle);
    if (timer !== null) clearTimeout(timer);
    idle = null;
    timer = null;
    cancelQuestionBasePrewarm(session, scope);
  };
  const run = () => {
    idle = null;
    timer = null;
    if (
      !alive ||
      !visible ||
      document.hidden ||
      !surface.isConnected ||
      isBusy()
    )
      return;
    void prewarmQuestionBase(
      session,
      scope,
      question,
      surface,
      () =>
        !alive ||
        !visible ||
        document.hidden ||
        !surface.isConnected ||
        isBusy(),
    ).catch(() => {});
  };
  const schedule = () => {
    if (!alive || !visible || idle !== null || timer !== null || isBusy())
      return;
    if (typeof window.requestIdleCallback === "function")
      idle = window.requestIdleCallback(run);
    else timer = setTimeout(run, 500);
  };
  const observer = new IntersectionObserver((changes) => {
    for (const change of changes) {
      if (change.target !== surface) continue;
      visible = change.isIntersecting;
      if (visible) schedule();
      else cancel();
    }
  });
  const onPointerDown = (event: PointerEvent) => {
    if (event.target instanceof Element && event.target.closest("canvas"))
      cancel();
  };
  const onVisibility = () => {
    if (document.hidden) cancel();
    else schedule();
  };
  observer.observe(surface);
  document.addEventListener("click", schedule);
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    alive = false;
    cancel();
    observer.disconnect();
    document.removeEventListener("click", schedule);
    document.removeEventListener("pointerdown", onPointerDown, {
      capture: true,
    });
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
