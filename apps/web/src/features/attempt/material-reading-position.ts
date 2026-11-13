/**
 * 材料阅读位置的会话内保留（QM-08 细项 3）：「查看材料」跳转离开后再回来
 * 不丢已读位置。纯内存 Map（键 = attemptId|groupId）——不落 localStorage：
 * 材料内容不进入持久化存储，会话结束即弃（与题级阅读位置
 * use-reading-position 的持久化语义不同：那是整卷作答续读，这是组内往返）。
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

export interface MaterialJumpSignal {
  questionId: string;
  seq: number;
}

const offsets = new Map<string, number>();

/** 读取某组材料区域的已读偏移（px；0 = 未记录/未读） */
export function materialReadingOffsetOf(key: string): number {
  return offsets.get(key) ?? 0;
}

/** 记录偏移（滚动监听高频调用：同值直接跳过写 Map） */
export function noteMaterialReadingOffset(key: string, offset: number): void {
  if (!Number.isFinite(offset) || offset < 0) return;
  if (offsets.get(key) === offset) return;
  offsets.set(key, offset);
}

/**
 * 材料列滚动 → 记录已读偏移（组材料列与题级材料锚共用，P1-2 抽出）：
 * 列内自身滚动记 scrollTop；整页流式（stack/窄屏）记页面滚过顶部的距离
 * （截断到材料自身高度）。readingKey 未定义（不记录语境）零行为。
 */
function useMaterialReadingPosition(
  elementRef: RefObject<HTMLElement | null>,
  readingKey: string | undefined,
): void {
  useEffect(() => {
    if (readingKey === undefined) return;
    const element = elementRef.current;
    if (element === null) return;
    let frame = 0;
    const record = () => {
      frame = 0;
      const node = elementRef.current;
      if (node === null || readingKey === undefined) return;
      if (node.scrollHeight > node.clientHeight) {
        // compare 模式：列内自身滚动，偏移即 scrollTop
        noteMaterialReadingOffset(readingKey, node.scrollTop);
      } else {
        // stack 模式：页面滚过材料顶部的距离（截断到材料自身高度）
        const top = node.getBoundingClientRect().top;
        noteMaterialReadingOffset(
          readingKey,
          Math.min(Math.max(-top, 0), node.scrollHeight),
        );
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(record);
    };
    element.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule);
    };
  }, [readingKey, elementRef]);
}

interface PendingMaterialReveal {
  focused: Element | null;
  x: number;
  y: number;
  ancestors: { node: HTMLElement; left: number; top: number }[];
}

/** 组头代替材料响应后，只在用户位置和焦点未变时接续晚到材料。 */
function pendingRevealOf(target: HTMLElement): PendingMaterialReveal {
  const ancestors: PendingMaterialReveal["ancestors"] = [];
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    ancestors.push({ node, left: node.scrollLeft, top: node.scrollTop });
  }
  return {
    focused: document.activeElement,
    x: window.scrollX,
    y: window.scrollY,
    ancestors,
  };
}

function pendingRevealUnchanged(pending: PendingMaterialReveal): boolean {
  return (
    pending.focused === document.activeElement &&
    pending.x === window.scrollX &&
    pending.y === window.scrollY &&
    pending.ancestors.every(
      ({ node, left, top }) =>
        node.scrollLeft === left && node.scrollTop === top,
    )
  );
}

/** 显式跳题和查看材料共用定位规则，隐藏期间保留最近一次信号。 */
export function useMaterialNavigation({
  elementRef,
  fallbackRef,
  hasMaterials,
  hidden,
  questionIds,
  readingKey,
  revealSignal,
  jumpSignal,
}: {
  elementRef: RefObject<HTMLElement | null>;
  fallbackRef?: RefObject<HTMLElement | null>;
  hasMaterials: boolean;
  hidden: boolean;
  questionIds: readonly string[];
  readingKey: string | undefined;
  revealSignal: number;
  jumpSignal: MaterialJumpSignal | null | undefined;
}): void {
  useMaterialReadingPosition(
    elementRef,
    hidden || !hasMaterials ? undefined : readingKey,
  );
  const lastJumpSeq = useRef(0);
  const lastReveal = useRef<{
    key: string | undefined;
    signal: number;
    target: HTMLElement;
    pending: PendingMaterialReveal | null;
  }>(null);
  useEffect(() => {
    if (hidden) return;
    const node = hasMaterials ? elementRef.current : null;
    const newJump = jumpSignal && jumpSignal.seq !== lastJumpSeq.current;
    if (newJump) lastJumpSeq.current = jumpSignal.seq;
    const target = node ?? fallbackRef?.current;
    const previous = lastReveal.current;
    const sameReveal =
      previous?.key === readingKey && previous?.signal === revealSignal;
    // 后续显式导航会废止旧请求；同次渲染的新 reveal 仍优先。
    if (sameReveal && newJump && previous) previous.pending = null;
    const retarget =
      previous !== null &&
      previous.target !== target &&
      previous.pending !== null &&
      pendingRevealUnchanged(previous.pending);
    // 同一次渲染里，查看材料优先于切题联动，避免两次滚动争抢位置。
    if (target && revealSignal !== 0 && (!sameReveal || retarget)) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
      lastReveal.current = {
        key: readingKey,
        signal: revealSignal,
        target,
        pending: node ? null : pendingRevealOf(target),
      };
      if (!node) return;
      const offset =
        readingKey === undefined ? 0 : materialReadingOffsetOf(readingKey);
      if (offset > 0) {
        if (node.scrollHeight > node.clientHeight) node.scrollTop = offset;
        else
          window.scrollBy({
            top: node.getBoundingClientRect().top + offset,
            behavior: "instant",
          });
      }
      node.focus({ preventScroll: true });
      return;
    }
    if (
      newJump &&
      questionIds.includes(jumpSignal.questionId) &&
      node &&
      node.scrollHeight > node.clientHeight
    ) {
      node.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [
    elementRef,
    fallbackRef,
    hasMaterials,
    hidden,
    jumpSignal,
    questionIds,
    readingKey,
    revealSignal,
  ]);
}
