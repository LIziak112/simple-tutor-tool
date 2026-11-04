import { useLayoutEffect, useRef } from "react";

const guards = new Set<() => Promise<void>>();
const finalGuards = new Set<() => Promise<void>>();
let generation = 0;
let preparing = false;
const pointers = new Set<number>();
let composing = false;

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => pointers.add(event.pointerId),
    true,
  );
  const endPointer = (event: PointerEvent) => pointers.delete(event.pointerId);
  document.addEventListener("pointerup", endPointer, true);
  document.addEventListener("pointercancel", endPointer, true);
  document.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    true,
  );
  document.addEventListener(
    "compositionend",
    () => {
      composing = false;
    },
    true,
  );
  window.addEventListener("blur", () => {
    pointers.clear();
  });
}

export function registerPwaUpdateGuard(
  prepare: () => Promise<void>,
  afterEditors = false,
): () => void {
  const target = afterEditors ? finalGuards : guards;
  target.add(prepare);
  generation++;
  return () => {
    if (target.delete(prepare)) generation++;
  };
}

/** 账号或材料作用域变化会使旧的更新准备失效，回调始终读取当前状态。 */
export function usePwaUpdateGuard(
  prepare: () => Promise<void>,
  scopeKey: string,
  afterEditors = false,
): void {
  const latest = useRef(prepare);
  const latestScope = useRef(scopeKey);
  latest.current = prepare;
  latestScope.current = scopeKey;
  useLayoutEffect(
    () =>
      registerPwaUpdateGuard(async () => {
        if (latestScope.current !== scopeKey)
          throw new Error("页面或账号已变化，请重新检查保存状态");
        await latest.current();
        if (latestScope.current !== scopeKey)
          throw new Error("页面或账号已变化，请重新检查保存状态");
      }, afterEditors),
    [scopeKey, afterEditors],
  );
}

export interface PreparedPwaUpdate {
  assertReady(): void;
  release(): void;
}

/** 只负责停止新增输入和等待已注册保存，不提交题目、不清理任何存储。 */
export async function preparePwaUpdate(
  signal?: AbortSignal,
): Promise<PreparedPwaUpdate> {
  if (signal?.aborted) throw new Error("更新准备已取消，稿件仍保留在当前页面");
  if (preparing) throw new Error("正在准备更新，请稍候");
  if (pointers.size > 0 || composing)
    throw new Error("请先结束书写或输入，再保存并更新");
  const otherDialog = [
    ...document.querySelectorAll('[role="dialog"], dialog[open]'),
  ].some(
    (element) =>
      !element.hasAttribute("data-pwa-update-dialog") &&
      element.getAttribute("data-state") !== "closed" &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden") &&
      getComputedStyle(element).display !== "none",
  );
  if (otherDialog) throw new Error("请先保存并关闭当前编辑窗口，再更新");
  const leave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leave);
  if (leave.defaultPrevented)
    throw new Error("当前有未保存的编辑，请先保存或取消后再更新");
  preparing = true;
  const root = document.getElementById("root");
  const wasInert = root?.hasAttribute("inert") ?? false;
  root?.setAttribute("inert", "");
  const block = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blockedEvents = [
    "pointerdown",
    "keydown",
    "beforeinput",
    "compositionstart",
    "drop",
    "paste",
  ];
  for (const type of blockedEvents)
    document.addEventListener(type, block, true);
  let released = false;
  let onAbort: (() => void) | undefined;
  const release = () => {
    if (released) return;
    released = true;
    for (const type of blockedEvents)
      document.removeEventListener(type, block, true);
    if (!wasInert) root?.removeAttribute("inert");
    preparing = false;
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  };
  const initialGeneration = generation;
  const assertReady = () => {
    if (released) throw new Error("更新准备已取消，请重新保存并更新");
    if (generation !== initialGeneration)
      throw new Error("页面或账号已变化，请重新检查保存状态");
  };
  try {
    // 题目输入可能在失焦时提交最后一次修改，先纳入当前保存回合。
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    await Promise.resolve();
    assertReady();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        release();
        reject(new Error("更新准备已取消或超时，稿件仍保留在当前页面"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    await Promise.race([
      (async () => {
        for (const guard of [...guards, ...finalGuards]) {
          await guard();
          assertReady();
        }
      })(),
      aborted,
    ]);
    return { assertReady, release };
  } catch (error) {
    release();
    throw error;
  }
}
