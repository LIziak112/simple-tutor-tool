import type { MemoAnchor } from "@tutor/contract";
import { MEMO_ANCHOR_NONE } from "@tutor/contract";
import { useEffect, useSyncExternalStore } from "react";

/**
 * 「我现在在哪」外部存储（模块 5 第一步，计划 §8.3「上下文锚自动」）：
 * 作答 / 结果 / 讲练页经 AI 伴学 Dock 的宿主发布当前题，讲义阅读页发布当前讲义；
 * 随笔记录端读它，随手记的那条自动锚到当时所在的题 / 讲义，离开页面即清空
 * （没有上下文时只带时间与设备）。
 *
 * 不做成 Context：发布方（答题页深处的 hook）与消费方（布局层的浮动随手记）
 * 不在同一棵子树里；模块级 store + useSyncExternalStore 是最小接法。
 */
let current: MemoAnchor = MEMO_ANCHOR_NONE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function sameAnchor(a: MemoAnchor, b: MemoAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "question" && b.kind === "question") {
    return (
      a.attemptId === b.attemptId &&
      a.questionId === b.questionId &&
      a.label === b.label
    );
  }
  if (a.kind === "lecture" && b.kind === "lecture") {
    return (
      a.lectureId === b.lectureId &&
      a.sectionId === b.sectionId &&
      a.label === b.label
    );
  }
  return true;
}

export function publishLearningFocus(anchor: MemoAnchor): void {
  if (sameAnchor(current, anchor)) return;
  current = anchor;
  emit();
}

/** 只清掉自己发布的那个锚（两页切换时后发布者的锚不被先离开者误清） */
export function clearLearningFocus(anchor: MemoAnchor): void {
  if (!sameAnchor(current, anchor)) return;
  current = MEMO_ANCHOR_NONE;
  emit();
}

export function getLearningFocus(): MemoAnchor {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLearningFocus(): MemoAnchor {
  return useSyncExternalStore(subscribe, getLearningFocus, getLearningFocus);
}

/**
 * 发布方 hook：anchor 为 null 时不发布（如无当前题）；变化即重发；卸载 / 变化前
 * 清掉自己发布的旧锚。
 */
export function usePublishLearningFocus(anchor: MemoAnchor | null): void {
  const key = anchor === null ? "" : JSON.stringify(anchor);
  useEffect(() => {
    if (key === "") return;
    const value = JSON.parse(key) as MemoAnchor;
    publishLearningFocus(value);
    return () => clearLearningFocus(value);
  }, [key]);
}

/** 测试用：回到初始态 */
export function resetLearningFocusForTest(): void {
  current = MEMO_ANCHOR_NONE;
  emit();
}
