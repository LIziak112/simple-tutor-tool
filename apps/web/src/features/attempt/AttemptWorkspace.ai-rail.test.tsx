import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AttemptQuestionPublic } from "@tutor/contract";
import { forwardRef, type ReactNode, useEffect, useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiCompanionRail,
  AiCompanionTrigger,
} from "@/features/student-ai/AiCompanionRail";
import {
  type AiCompanionLayoutController,
  useAiCompanionLayout,
} from "@/features/student-ai/ai-companion-layout";
import { stubElementWidth } from "@/test/stub-element-width";
import {
  AttemptEditorProvider,
  useAttemptEditor,
} from "./AttemptEditorContext";
import { AttemptQuestionCard } from "./AttemptQuestionCard";

/**
 * SAI-19 伴学栏与作答区的组合层测试（B10 必须先测②③④的组合面）：
 * - 控制器身份稳定：开/关 AI、dock↔panel 模式切换不重挂题卡/标画控制器
 *   （组件实例计数 + 标画题目对象身份，不只比截图）；
 * - 正在书写且保存失败：布局不变、面板不开、未命中笔迹与 undo 历史保留；
 * - 既有圈画换宽后题面与笔迹对齐（不重挂＝既有固化题面几何逻辑继续生效），
 *   草稿关闭时题干仍整行（note-body-row 列向堆叠不变）；
 * - 开关与模式切换不强制把题面滚到顶部。
 * 状态机与视图壳单层见 student-ai 目录两个测试文件。
 */

const probe = vi.hoisted(() => ({
  overlayMounts: 0,
  overlayUnmounts: 0,
  questions: [] as AttemptQuestionPublic[],
}));

vi.mock("@/features/annotation/QuestionAnnotationOverlay", () => ({
  QuestionAnnotationOverlay: forwardRef(function Overlay(
    {
      question,
      children,
    }: { question: AttemptQuestionPublic; children: ReactNode },
    _ref,
  ) {
    useEffect(() => {
      // 实例计数：只在挂载/卸载时计数（函数体每次渲染都会执行）
      probe.overlayMounts += 1;
      return () => {
        probe.overlayUnmounts += 1;
      };
    }, []);
    probe.questions.push(question);
    return children;
  }),
}));
vi.mock("@/features/notes/NoteLayer", () => ({ NoteLayer: () => null }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiConnectionsApi: vi.fn(async () => ({ connections: [] })),
  };
});

const QUESTION: AttemptQuestionPublic = {
  id: "q",
  questionRevisionId: "11111111-1111-4111-8111-111111111111",
  type: "judge",
  stemMd: "公开题面：判断对错",
  knowledge: [],
  difficulty: 1,
  hintCount: 0,
};

/** 宽度桩（@/test/stub-element-width，与 student-ai 布局测试共用） */
let width: ReturnType<typeof stubElementWidth>;
const setWidth = (next: number) => width.setWidth(next);

const captured: { controller: AiCompanionLayoutController | null } = {
  controller: null,
};

/** 注册一个会失败/成功的收笔控制器（模拟正在书写的题） */
function RegisterFlush({ impl }: { impl: () => Promise<void> }) {
  const editor = useAttemptEditor();
  useEffect(
    () => editor?.register(QUESTION.id, impl, "annotation"),
    [editor, impl],
  );
  return null;
}

function Harness({ flushImpl }: { flushImpl: () => Promise<void> }) {
  // 惰性初始化：rerender 换 flushImpl 时不重建 client（缓存与订阅保持）
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AttemptEditorProvider>
        <MemoryRouter>
          <HarnessInner flushImpl={flushImpl} />
        </MemoryRouter>
      </AttemptEditorProvider>
    </QueryClientProvider>
  );
}

function HarnessInner({ flushImpl }: { flushImpl: () => Promise<void> }) {
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editor = useAttemptEditor(null);
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor,
    currentQuestionId: QUESTION.id,
  });
  captured.controller = controller;
  return (
    <>
      <RegisterFlush impl={flushImpl} />
      <AiCompanionTrigger ref={triggerRef} controller={controller} />
      <AiCompanionRail
        containerRef={railRef}
        controller={controller}
        triggerRef={triggerRef}
        questionLabel="第 1 题"
        settingsHref="/s/settings/ai?from=%2Fs%2Fassignments%2Fa1"
      >
        <AttemptQuestionCard
          question={QUESTION}
          answer={undefined}
          index={0}
          attemptId="attempt"
          flagged={false}
          onAnswer={() => undefined}
        />
      </AiCompanionRail>
    </>
  );
}

const openViaTrigger = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  });
};
const closeViaTrigger = () => {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  });
};
const railState = () =>
  document
    .querySelector('[data-slot="ai-companion-rail"]')
    ?.getAttribute("data-ai-state");

let scrollSpies: (() => void)[] = [];
beforeEach(() => {
  width = stubElementWidth();
  probe.overlayMounts = 0;
  probe.overlayUnmounts = 0;
  probe.questions = [];
  captured.controller = null;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  // jsdom 无 scrollIntoView：先补定义（断言经 collectScrollMocks 监听调用）
  Element.prototype.scrollIntoView = vi.fn();
  const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  scrollSpies = [
    () => {
      // jsdom 无 scrollIntoView：恢复“未定义”用 Reflect 删除，绕开
      // lib.dom 对必填方法的 delete 检查（效果与 delete 相同）。
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      scrollBy.mockRestore();
      scrollTo.mockRestore();
    },
  ];
});
afterEach(() => {
  width.restore();
  vi.unstubAllGlobals();
  for (const restore of scrollSpies) restore();
  scrollSpies = [];
});

describe("SAI-19 伴学栏组合层", () => {
  it("必须先测③：开/关 AI 与 dock↔panel 模式切换不重挂题卡与标画控制器", async () => {
    const okFlush = async () => {};
    render(<Harness flushImpl={okFlush} />);
    expect(screen.getByText("公开题面：判断对错")).toBeInTheDocument();
    const initialOverlayCount = probe.overlayMounts;
    const initialQuestion = probe.questions.at(-1);
    expect(initialOverlayCount).toBeGreaterThan(0);

    // 开 dock → 关 → 窄屏开 panel → 开着变宽回 dock → 关
    await openViaTrigger();
    expect(railState()).toBe("dock");
    closeViaTrigger();
    expect(railState()).toBe("closed");
    setWidth(500);
    await openViaTrigger();
    expect(
      await screen.findByRole("dialog", { name: "AI 助教" }),
    ).toBeInTheDocument();
    setWidth(1400);
    expect(
      await screen.findByRole("complementary", { name: "AI 助教" }),
    ).toBeInTheDocument();
    closeViaTrigger();

    // 组件实例计数与题目对象身份全程不变（非截图比对）
    expect(probe.overlayMounts).toBe(initialOverlayCount);
    expect(probe.overlayUnmounts).toBe(0);
    expect(probe.questions.at(-1)).toBe(initialQuestion);
    expect(screen.getByText("公开题面：判断对错")).toBeInTheDocument();
  });

  it("必须先测②：正在书写且保存失败——布局不变、面板不开、笔迹与 undo 保留", async () => {
    const failingFlush = async () => {
      throw new Error("本机稿写入失败");
    };
    const view = render(<Harness flushImpl={failingFlush} />);
    expect(probe.overlayMounts).toBeGreaterThan(0);
    const mountsBefore = probe.overlayMounts;

    await openViaTrigger();
    // 布局完全不变：面板未开、无对话框、题面原位
    expect(railState()).toBe("closed");
    expect(
      screen.queryByRole("complementary", { name: "AI 助教" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("本机稿写入失败");
    // 未命中笔迹不消失、redo/undo 历史保留：控制器未卸载未重挂
    // （真实撤销栈在真实标画控制器内，mock 层以不重挂为其结构证明；
    // flush 不清撤销历史另由 SAI-10 AttemptEditorContext 契约测试覆盖）
    expect(probe.overlayMounts).toBe(mountsBefore);

    // 落盘恢复后重开成功，警示清除
    view.rerender(<Harness flushImpl={async () => {}} />);
    await act(async () => {
      await captured.controller?.openPanel();
    });
    expect(railState()).toBe("dock");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("必须先测④：AI 换宽后草稿关闭时题干仍整行，标画题目对象身份稳定", async () => {
    const okFlush = async () => {};
    render(<Harness flushImpl={okFlush} />);
    const initialQuestion = probe.questions.at(-1);
    const noteRow = () =>
      document.querySelector<HTMLElement>('[data-slot="note-body-row"]');
    // 草稿关闭：题干整行（列向堆叠），AI dock 打开前后不变
    expect(noteRow()?.style.flexDirection).toBe("column");
    await openViaTrigger();
    expect(railState()).toBe("dock");
    expect(noteRow()?.style.flexDirection).toBe("column");
    closeViaTrigger();
    expect(noteRow()?.style.flexDirection).toBe("column");
    // 既有圈画换宽对齐：题目对象未被重建（固化题面几何逻辑继续生效）
    expect(probe.questions.at(-1)).toBe(initialQuestion);
  });

  it("开关与模式切换不强制把题面滚到顶部", async () => {
    const okFlush = async () => {};
    render(<Harness flushImpl={okFlush} />);
    const { scrollIntoView, scrollBy, scrollTo } = collectScrollMocks();
    await openViaTrigger();
    setWidth(500);
    await screen.findByRole("dialog", { name: "AI 助教" });
    setWidth(1400);
    await screen.findByRole("complementary", { name: "AI 助教" });
    closeViaTrigger();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    // 关闭可回原题：题卡仍在文档中（同一实例，未重挂）
    expect(screen.getByText("公开题面：判断对错")).toBeInTheDocument();
  });
});

function collectScrollMocks() {
  const intoView = vi.mocked(Element.prototype.scrollIntoView);
  const by = vi.mocked(window.scrollBy);
  const to = vi.mocked(window.scrollTo);
  return { scrollIntoView: intoView, scrollBy: by, scrollTo: to };
}
