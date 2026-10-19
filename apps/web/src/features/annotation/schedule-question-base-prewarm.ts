import type { AttemptQuestionPublic } from "@tutor/contract";
import type { AnnotationScope, AnnotationSessionRef } from "./annotation-store";
import {
  cancelQuestionBasePrewarm,
  interruptQuestionBasePrewarm,
  prewarmQuestionBase,
} from "./question-base-prewarm";

/** 用户停止交互后再预备，避免栅格化与显式打开争用主线程。 */
const PREWARM_IDLE_DELAY_MS = 750;

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
  const clearScheduled = () => {
    if (idle !== null) window.cancelIdleCallback(idle);
    if (timer !== null) clearTimeout(timer);
    idle = null;
    timer = null;
  };
  const cancel = () => {
    clearScheduled();
    cancelQuestionBasePrewarm(session, scope);
  };
  const interrupt = () => {
    clearScheduled();
    interruptQuestionBasePrewarm(session, scope);
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
    timer = setTimeout(() => {
      timer = null;
      if (!alive || !visible || isBusy()) return;
      if (typeof window.requestIdleCallback === "function")
        idle = window.requestIdleCallback(run);
      else run();
    }, PREWARM_IDLE_DELAY_MS);
  };
  const observer = new IntersectionObserver((changes) => {
    for (const change of changes) {
      if (change.target !== surface) continue;
      visible = change.isIntersecting;
      if (visible) schedule();
      else cancel();
    }
  });
  const onInteraction = () => interrupt();
  const onVisibility = () => {
    if (document.hidden) cancel();
    else schedule();
  };
  observer.observe(surface);
  document.addEventListener("click", onInteraction, { capture: true });
  document.addEventListener("click", schedule);
  document.addEventListener("pointerdown", onInteraction, { capture: true });
  document.addEventListener("keydown", onInteraction, { capture: true });
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    alive = false;
    cancel();
    observer.disconnect();
    document.removeEventListener("click", onInteraction, { capture: true });
    document.removeEventListener("click", schedule);
    document.removeEventListener("pointerdown", onInteraction, {
      capture: true,
    });
    document.removeEventListener("keydown", onInteraction, {
      capture: true,
    });
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
