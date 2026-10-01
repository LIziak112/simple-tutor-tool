import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLectureSectionFocus } from "./use-lecture-section-focus";

/**
 * 讲义分节聚焦 hook 测试（T4.0b，§5.0-C13 逐条）：
 * 起始节确立、余量内立即切换、不足余量的迟滞（稳定 ≥1s）、全部移出视口保持、
 * 候选抖动不切换、平局取靠前标题、选择器只取 .rich-markdown 内的 h2/h3。
 * jsdom 无 IntersectionObserver：注入可控 mock（回调由用例显式驱动）。
 */

interface MockEntry {
  target: Element;
  intersectionRatio: number;
  isIntersecting: boolean;
}

/** 可控的 IntersectionObserver mock：observe 登记、emit 驱动回调 */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static last(): MockIntersectionObserver | undefined {
    return MockIntersectionObserver.instances.at(-1);
  }
  private readonly targets = new Set<Element>();
  constructor(
    private readonly callback: (
      entries: MockEntry[],
      observer: MockIntersectionObserver,
    ) => void,
  ) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  observed(): Element[] {
    return [...this.targets];
  }
  emit(ratios: Array<{ el: Element; ratio: number }>): void {
    const entries = ratios.map(({ el, ratio }) => ({
      target: el,
      intersectionRatio: ratio,
      isIntersecting: ratio > 0,
    }));
    this.callback(entries, this);
  }
}

function Harness(props: {
  enabled: boolean;
  sourceKey: string;
  onSectionFocus: (index: number) => void;
}) {
  useLectureSectionFocus(props);
  return null;
}

/** 挂两节正文（h2×2 + h3）的 .rich-markdown 容器，返回全部标题元素 */
function mountLecture(headings: string[]): HTMLElement {
  const host = document.createElement("div");
  const rich = document.createElement("div");
  rich.className = "rich-markdown";
  const els: HTMLElement[] = [];
  for (const text of headings) {
    const h = document.createElement(text.startsWith("###") ? "h3" : "h2");
    h.textContent = text.replace(/^#+\s*/, "");
    rich.appendChild(h);
    els.push(h);
  }
  // 容器外的 h2 不应被观察（选择器同源校验）
  const outside = document.createElement("h2");
  outside.textContent = "容器外标题";
  host.appendChild(rich);
  host.appendChild(outside);
  document.body.appendChild(host);
  return rich;
}

let originalIO: unknown;

beforeEach(() => {
  originalIO = globalThis.IntersectionObserver;
  MockIntersectionObserver.instances = [];
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
  if (originalIO === undefined) {
    // jsdom 原本无 IntersectionObserver：还原为「不存在」
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      undefined;
  } else {
    globalThis.IntersectionObserver = originalIO as typeof IntersectionObserver;
  }
});

describe("useLectureSectionFocus（§5.0-C13）", () => {
  it("选择器只取 .rich-markdown 内的 h2/h3（与 scrollToHeading 同源）", () => {
    const rich = mountLecture(["## 一", "### 一点五", "## 二"]);
    render(<Harness enabled sourceKey="md" onSectionFocus={() => undefined} />);
    const observer = MockIntersectionObserver.last();
    expect(observer).toBeDefined();
    const observed = observer?.observed() ?? [];
    expect(observed).toEqual([...rich.querySelectorAll("h2, h3")]);
    expect(observed).toHaveLength(3);
  });

  it("首个可见标题即上报为起始节（进入讲义页=到达第 0 节）", () => {
    const rich = mountLecture(["## 一", "## 二"]);
    const seen: number[] = [];
    render(
      <Harness enabled sourceKey="md" onSectionFocus={(i) => seen.push(i)} />,
    );
    const observer = MockIntersectionObserver.last();
    const [h0, h1] = [...rich.querySelectorAll("h2")];
    act(() => {
      observer?.emit([
        { el: h0 as Element, ratio: 0.8 },
        { el: h1 as Element, ratio: 0 },
      ]);
    });
    expect(seen).toEqual([0]);
  });

  it("新节占比超当前节 0.1 余量：立即切换上报", () => {
    const rich = mountLecture(["## 一", "## 二"]);
    const seen: number[] = [];
    render(
      <Harness enabled sourceKey="md" onSectionFocus={(i) => seen.push(i)} />,
    );
    const observer = MockIntersectionObserver.last();
    const [h0, h1] = [...rich.querySelectorAll("h2")];
    act(() => {
      observer?.emit([{ el: h0 as Element, ratio: 1 }]);
    });
    // 新节 0.9 > 当前 0.3 + 0.1：立即切换
    act(() => {
      observer?.emit([
        { el: h0 as Element, ratio: 0.3 },
        { el: h1 as Element, ratio: 0.9 },
      ]);
    });
    expect(seen).toEqual([0, 1]);
  });

  it("不足余量：迟滞 1s 稳定后才切换；稳定期内回落则不切（防折叠展开抖动）", () => {
    vi.useFakeTimers();
    try {
      const rich = mountLecture(["## 一", "## 二"]);
      const seen: number[] = [];
      render(
        <Harness enabled sourceKey="md" onSectionFocus={(i) => seen.push(i)} />,
      );
      const observer = MockIntersectionObserver.last();
      const [h0, h1] = [...rich.querySelectorAll("h2")];
      act(() => {
        observer?.emit([{ el: h0 as Element, ratio: 1 }]);
      });
      // 新节 0.55 未超当前 0.5+0.1：进入候选，不立即上报
      act(() => {
        observer?.emit([
          { el: h0 as Element, ratio: 0.5 },
          { el: h1 as Element, ratio: 0.55 },
        ]);
      });
      expect(seen).toEqual([0]);
      // 稳定期内当前节回到最大（折叠块展开的瞬时抖动）：候选取消，不切换
      act(() => {
        observer?.emit([
          { el: h0 as Element, ratio: 0.9 },
          { el: h1 as Element, ratio: 0.3 },
        ]);
      });
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(seen).toEqual([0]);
      // 再次进入候选并稳定 1s：切换
      act(() => {
        observer?.emit([
          { el: h0 as Element, ratio: 0.5 },
          { el: h1 as Element, ratio: 0.55 },
        ]);
      });
      act(() => {
        observer?.emit([
          { el: h0 as Element, ratio: 0.2 },
          { el: h1 as Element, ratio: 0.45 },
        ]);
      });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(seen).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("全部标题移出视口（长节中部）：保持当前节不再上报", () => {
    const rich = mountLecture(["## 一", "## 二"]);
    const seen: number[] = [];
    render(
      <Harness enabled sourceKey="md" onSectionFocus={(i) => seen.push(i)} />,
    );
    const observer = MockIntersectionObserver.last();
    const [h0, h1] = [...rich.querySelectorAll("h2")];
    act(() => {
      observer?.emit([
        { el: h0 as Element, ratio: 1 },
        { el: h1 as Element, ratio: 0.5 },
      ]);
    });
    act(() => {
      observer?.emit([
        { el: h0 as Element, ratio: 0 },
        { el: h1 as Element, ratio: 0 },
      ]);
    });
    expect(seen).toEqual([0]);
  });

  it("占比平局取文档序靠前的标题（保守停在早节）", () => {
    const rich = mountLecture(["## 一", "## 二"]);
    const seen: number[] = [];
    render(
      <Harness enabled sourceKey="md" onSectionFocus={(i) => seen.push(i)} />,
    );
    const observer = MockIntersectionObserver.last();
    const [h0, h1] = [...rich.querySelectorAll("h2")];
    // 两节均 1.0：best 取 0；当前已是 0，无新事件
    act(() => {
      observer?.emit([
        { el: h0 as Element, ratio: 1 },
        { el: h1 as Element, ratio: 1 },
      ]);
    });
    expect(seen).toEqual([0]);
  });
});
