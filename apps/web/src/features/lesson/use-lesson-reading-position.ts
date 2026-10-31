import { type RefObject, useEffect } from "react";
import { LESSON_HEADING_SELECTOR } from "@/features/markdown/use-lecture-section-focus";

/**
 * 讲练页阅读位置（2026-10-30，主人直派 #16910）：
 * 按「作答卷」持久化学生读到哪一节/哪道题，重新进入讲练页时自动回到原位。
 *
 * 与作答页 useReadingPosition（整卷续读、按标注会话隔离、懒挂载强挂）的区别：
 * - 讲练页的 md 段与题卡在首屏一次性渲染，锚点取「目录标题 + 题卡」中视口上沿
 *   最近的一个——节与题都能定位，不依赖题目是否已挂载；
 * - 存储键以 attemptId 隔离：刷新/重开同一卷回到原位，「再做一次」新卷从顶部
 *   开始（新卷没有记录，也不会串到旧卷）；
 * - 恢复前等布局稳定（字体/图片就绪且几何连续 3 次采样一致）；用户先操作则
 *   让用户接管，绝不延迟抢滚动；恢复死线 5s 到点按现状对齐一次。
 *
 * 阅读位置不是答案：localStorage 不可用、记录损坏或锚点已消失时静默降级，
 * 不阻断作答。
 */

const STORAGE_PREFIX = "lesson-reading:";
/** 顶部工具栏（HeaderBar）：恢复偏移以它为基准，与作答页题头同口径 */
const HEADER_SELECTOR = '[data-slot="lesson-header"]';
const INTERACTION_EVENTS = [
  "wheel",
  "touchstart",
  "pointerdown",
  "keydown",
] as const;
const RESTORE_INTERVAL_MS = 100;
const RESTORE_STABLE_SAMPLES = 3;
const RESTORE_DEADLINE_MS = 5000;
const SAVE_DEBOUNCE_MS = 200;

interface ReadingAnchor {
  /** h:<标题下标>（与目录同源）或 q:<questionId> */
  anchor: string;
  /** 元素视口顶 - 工具栏底（负值 = 已滚过元素顶部） */
  offset: number;
}

function headerHeightOf(): number {
  return (
    document.querySelector(HEADER_SELECTOR)?.getBoundingClientRect().height ??
    64
  );
}

function readAnchor(key: string): ReadingAnchor | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "anchor" in raw &&
      typeof raw.anchor === "string" &&
      /^(?:h:\d+|q:.+)$/.test(raw.anchor) &&
      "offset" in raw &&
      typeof raw.offset === "number" &&
      Number.isFinite(raw.offset)
    )
      return { anchor: raw.anchor, offset: raw.offset };
  } catch {
    // 阅读位置不是答案：存储不可用时不阻断作答。
  }
  return null;
}

/** 当前 DOM 里的全部锚点（目录标题 + 题卡），键与目录/题目一一对应 */
function anchorElements(
  cards: RefObject<Map<string, HTMLElement>>,
): Map<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  document
    .querySelectorAll<HTMLElement>(LESSON_HEADING_SELECTOR)
    .forEach((element, index) => {
      elements.set(`h:${index}`, element);
    });
  for (const [questionId, element] of cards.current) {
    elements.set(`q:${questionId}`, element);
  }
  return elements;
}

/** 视口上沿（工具栏底 + 12px 呼吸位）最近的一个锚点 */
function captureAnchor(
  cards: RefObject<Map<string, HTMLElement>>,
): ReadingAnchor | null {
  const header = headerHeightOf();
  let best: { anchor: string; top: number } | null = null;
  for (const [anchor, element] of anchorElements(cards)) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue;
    if (rect.top > header + 12) continue;
    if (best === null || rect.top > best.top) best = { anchor, top: rect.top };
  }
  return best === null
    ? null
    : { anchor: best.anchor, offset: best.top - header };
}

/** 字体与图片就绪（恢复对位前不提前量到半成品布局） */
function layoutReady(): boolean {
  if (document.fonts?.status === "loading") return false;
  for (const image of Array.from(document.images)) {
    if (!image.complete) return false;
  }
  return true;
}

export function useLessonReadingPosition(options: {
  /** 作答卷 id：存储键按卷隔离（新卷从顶部开始） */
  readonly attemptId: string;
  /** 正文已渲染才挂锚点与恢复 */
  readonly enabled?: boolean;
  /** questionId → 题卡根元素（讲练页作答/回看两份视图共用） */
  readonly cards: RefObject<Map<string, HTMLElement>>;
}): void {
  const { attemptId, enabled = true, cards } = options;

  useEffect(() => {
    if (!enabled) return;
    const key = `${STORAGE_PREFIX}${attemptId}`;
    let pending = readAnchor(key);
    let latest: ReadingAnchor | null = null;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;

    const persist = () => {
      clearTimeout(saveTimer);
      if (latest === null) return;
      try {
        localStorage.setItem(key, JSON.stringify(latest));
      } catch {
        // 只降级阅读恢复，不影响答案与草稿保存。
      }
    };
    const capture = (save: boolean) => {
      frame = 0;
      // 恢复未完成前不落盘：否则离页可能把「顶部」覆盖掉上次位置。
      if (pending !== null) return;
      const anchor = captureAnchor(cards);
      if (anchor === null) return;
      latest = anchor;
      if (save) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => capture(true));
    };
    const onPageHide = () => {
      cancelAnimationFrame(frame);
      capture(true);
      persist();
    };
    const interrupt = () => {
      if (pending === null) return;
      pending = null;
      clearTimeout(restoreTimer);
      capture(true);
    };

    const deadline = performance.now() + RESTORE_DEADLINE_MS;
    let previous = "";
    let stable = 0;
    const tryRestore = () => {
      if (pending === null) return;
      const target = anchorElements(cards).get(pending.anchor);
      if (target === undefined) {
        // 锚点还没渲染（公式/图片管线仍在挂载）：继续等，死线到点放弃。
        if (performance.now() >= deadline) {
          pending = null;
          capture(false);
          return;
        }
        restoreTimer = setTimeout(tryRestore, RESTORE_INTERVAL_MS);
        return;
      }
      const rect = target.getBoundingClientRect();
      const geometry = JSON.stringify([
        headerHeightOf(),
        document.documentElement.scrollHeight,
        rect.top,
        rect.height,
      ]);
      stable = layoutReady() && geometry === previous ? stable + 1 : 0;
      previous = geometry;
      if (stable < RESTORE_STABLE_SAMPLES && performance.now() < deadline) {
        restoreTimer = setTimeout(tryRestore, RESTORE_INTERVAL_MS);
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
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    for (const event of INTERACTION_EVENTS)
      window.addEventListener(event, interrupt, { passive: true });
    capture(false);
    if (pending !== null) {
      restoreTimer = setTimeout(tryRestore, RESTORE_INTERVAL_MS);
    }
    return () => {
      pending = null;
      clearTimeout(restoreTimer);
      cancelAnimationFrame(frame);
      persist();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      for (const event of INTERACTION_EVENTS)
        window.removeEventListener(event, interrupt);
    };
  }, [attemptId, enabled, cards]);
}
