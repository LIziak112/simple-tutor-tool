/**
 * 工具栏随宽度自适应的三件事，都按真实布局量、不写死断点：
 * 1. 宽度不够时把重做收进「更多」；
 * 2. 还不够，工具区横向滑动——还有工具没露出来的那一侧渐隐，提示可以滑；
 * 3. 选中的工具被挤在可视区外时，把它滑进来。
 * 无布局的环境（单测）恒为宽版、不渐隐、不滑动。
 */
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * 重做按钮占的宽度（44px 按钮 + 间距）。收进「更多」之后，要富余出这么宽才放回
 * 工具栏——少于它就放回，会立刻又被挤走，来回跳。
 */
const REDO_SLOT_PX = 46;

/** 渐隐带的宽度 */
const FADE_PX = 16;

/** 工具区的内边距（InkToolbar 里的 p-1，给焦点环留的位置） */
const STRIP_PAD_PX = 4;

type ElementRef = RefObject<HTMLDivElement | null>;

/** 宽度不够时把重做收进「更多」（与旧版工具栏的位置一致） */
export function useRedoInMenu(rootRef: ElementRef, stripRef: ElementRef) {
  const [inMenu, setInMenu] = useState(false);
  const inMenuRef = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    const strip = stripRef.current;
    if (!root || !strip || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 工具区是唯一可压缩的一段：内容比可视宽度宽，就是放不下了
      const squeezed = strip.scrollWidth - strip.clientWidth > 1;
      let next = squeezed;
      if (inMenuRef.current && !squeezed) {
        let used = 0;
        for (const child of root.children) {
          used += child.getBoundingClientRect().width;
        }
        const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
        used += gap * Math.max(0, root.children.length - 1);
        next = root.clientWidth - used < REDO_SLOT_PX;
      }
      if (next === inMenuRef.current) return;
      inMenuRef.current = next;
      setInMenu(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(strip);
    measure();
    return () => observer.disconnect();
  }, [rootRef, stripRef]);
  return inMenu;
}

/** 工具区哪一侧还有工具没露出来 */
export type StripFade = "start" | "end" | "both";

/**
 * 工具区横向滑动时两侧的状态。toolCount 变了（宿主换了工具清单）重新量一次。
 */
export function useStripFade(
  stripRef: ElementRef,
  toolCount: number,
): StripFade | null {
  const [fade, setFade] = useState<StripFade | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies(toolCount): 工具数变了内容宽度就变，要重新量
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // 只剩内边距没露出来不算：那里没有工具
      const start = strip.scrollLeft > STRIP_PAD_PX;
      const end =
        strip.scrollWidth - strip.clientWidth - strip.scrollLeft > STRIP_PAD_PX;
      setFade(start && end ? "both" : start ? "start" : end ? "end" : null);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, [stripRef, toolCount]);
  return fade;
}

const FADE_MASK: Record<StripFade, string> = {
  start: `linear-gradient(to right, transparent, #000 ${FADE_PX}px)`,
  end: `linear-gradient(to left, transparent, #000 ${FADE_PX}px)`,
  both: `linear-gradient(to right, transparent, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), transparent)`,
};

/** 渐隐用遮罩做（不盖颜色，工具栏放在什么底色上都对）；旧版 Safari 认带前缀的 */
export function stripFadeStyle(fade: StripFade | null): CSSProperties {
  if (fade === null) return {};
  return { maskImage: FADE_MASK[fade], WebkitMaskImage: FADE_MASK[fade] };
}

/**
 * 选中的工具不在工具区的可视范围里时，把它滑进来。只动工具区自己的横向滚动，
 * 不用 scrollIntoView——那会连页面一起滚。
 */
export function useKeepToolVisible(stripRef: ElementRef, active: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies(active): 当前工具变了，按下的那个按钮就换了
  useEffect(() => {
    const strip = stripRef.current;
    const current = strip?.querySelector('[aria-pressed="true"]');
    if (!strip || !current) return;
    const view = strip.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    // 滑到连内边距一起露出来，焦点环不被裁掉
    if (box.left < view.left) {
      strip.scrollLeft -= view.left - box.left + STRIP_PAD_PX;
    } else if (box.right > view.right) {
      strip.scrollLeft += box.right - view.right + STRIP_PAD_PX;
    }
  }, [stripRef, active]);
}
