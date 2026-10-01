import { useEffect, useRef } from "react";

/**
 * 讲义分节聚焦 hook（T4.0b，方案 §4.3.2 / §5.0-C13）：
 * 「当前阅读节」切换时回调一次，供页面层入队 lecture_section_focus。
 *
 * 实现：复制 use-attempt-events 的 IntersectionObserver 模式
 * （threshold [0, 0.1, 0.25, 0.5, 1]，占比最大者为当前节），**去掉答题页的
 * 聚焦兜底耦合**（§2.6-2）。细节红线（§5.0-C13）：
 * - root 用默认视口（讲义滚动在文档层，正文非内部 overflow 容器）；
 * - 选择器写死 `.rich-markdown h2, .rich-markdown h3`，与 scrollToHeading
 *   同源（目录点击与聚焦观察永不漂移）；
 * - 判定「在视口内」显式 ratio > 0（ratio===0 且 isIntersecting===true 是
 *   W3C 合法状态；占比比较可行，但高于视口的节 ratio 永远到不了 1）；
 * - 不用 rootMargin 百分比做中线法（百分比按 root 宽度解析，iPad 横竖屏
 *   切换会改变判定带）；
 * - **迟滞**：新节占比超过当前节 0.1 余量才立即切换，否则需稳定 ≥1s——
 *   折叠块展开/steps 揭晓改变布局（旧 entry 异步才更新），防一串抖动事件；
 * - 全部标题移出视口（读到长节中部）时保持当前节不变。
 *
 * jsdom 等无 IntersectionObserver 的环境自动降级（不报任何事件）。
 */

/** 新节超过当前节占比的立即切换余量（§5.0-C13 迟滞） */
export const HYSTERESIS_MARGIN = 0.1;
/** 候选节的稳定时长（毫秒）：不足余量时需稳定该时长才切换 */
export const CANDIDATE_STABLE_MS = 1000;

/** 与 scrollToHeading 同一选择器（StudentLectureViewPage；不得两处漂移） */
export const LECTURE_HEADING_SELECTOR = ".rich-markdown h2, .rich-markdown h3";

export interface UseLectureSectionFocusOptions {
  /** 正文 DOM 就绪（讲义数据加载完成）才挂观察器 */
  readonly enabled: boolean;
  /** 观察目标集合的重建键（讲义 markdown；内容变化时重挂观察器） */
  readonly sourceKey: string;
  /** 「当前阅读节」切换时回调（headingIndex 与目录列表下标同源，0 起） */
  readonly onSectionFocus: (headingIndex: number) => void;
}

/**
 * 观察 `.rich-markdown h2/h3` 的视口占比，「当前阅读节」切换时回调。
 * 首个可见标题即上报为起始节（进入讲义页 = 到达第 0 节）。
 */
export function useLectureSectionFocus(
  options: UseLectureSectionFocusOptions,
): void {
  const { enabled, sourceKey, onSectionFocus } = options;
  // onSectionFocus 经 ref 取最新：页面回调内联时观察器不因引用变化重挂
  const callbackRef = useRef(onSectionFocus);
  callbackRef.current = onSectionFocus;

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>(LECTURE_HEADING_SELECTOR),
    );
    if (headings.length === 0) return;
    const indexByElement = new Map<Element, number>(
      headings.map((el, index) => [el, index]),
    );
    /** 各标题当前视口占比（IntersectionObserver 回调维护） */
    const ratios = new Map<Element, number>();
    /** 当前节（null=尚未确立，首个可见标题即确立并上报） */
    let current: number | null = null;
    /** 候选节（占比未过余量时观察其稳定性） */
    let candidateIndex: number | null = null;
    let candidateTimer: ReturnType<typeof setTimeout> | null = null;

    const report = (index: number): void => {
      current = index;
      candidateIndex = null;
      callbackRef.current(index);
    };

    /** 占比最大且在视口内的标题（平局取文档序靠前者——保守停在早节） */
    const bestVisible = (): number | null => {
      let best: number | null = null;
      let bestRatio = 0;
      for (const [el, ratio] of ratios) {
        const index = indexByElement.get(el);
        if (index === undefined || ratio <= 0) continue;
        // 严格大于：平局保留先遍历到的较小序号（ratios 按插入序=文档序遍历）
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = index;
        }
      }
      return best;
    };

    const evaluate = (): void => {
      const best = bestVisible();
      if (best === null) return; // 全部移出视口：保持当前节
      if (current === null) {
        report(best); // 起始节（进入讲义页即到达）
        return;
      }
      if (best === current) {
        candidateIndex = null;
        return;
      }
      const currentRatio = ratios.get(headings[current] as HTMLElement) ?? 0;
      const bestRatio = ratios.get(headings[best] as HTMLElement) ?? 0;
      if (bestRatio > currentRatio + HYSTERESIS_MARGIN) {
        report(best); // 超出余量：立即切换
        return;
      }
      // 不足余量：观察稳定性（≥1s 仍为最大占比者才切换，防折叠展开抖动）
      if (candidateIndex !== best) {
        candidateIndex = best;
        if (candidateTimer !== null) clearTimeout(candidateTimer);
        candidateTimer = setTimeout(() => {
          if (candidateIndex !== null && bestVisible() === candidateIndex) {
            report(candidateIndex);
          }
        }, CANDIDATE_STABLE_MS);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target, entry.intersectionRatio);
        }
        evaluate();
      },
      { threshold: [0, 0.1, 0.25, 0.5, 1] },
    );
    for (const el of headings) observer.observe(el);
    return () => {
      observer.disconnect();
      if (candidateTimer !== null) clearTimeout(candidateTimer);
    };
    // sourceKey 变化 = 讲义内容变化，重挂观察器重置当前节
  }, [enabled, sourceKey, callbackRef]);
}
