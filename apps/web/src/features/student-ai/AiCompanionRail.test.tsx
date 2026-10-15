import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AiConnectionListData } from "@tutor/contract";
import { useRef } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentAiConnectionsApi } from "@/lib/api";
import { AiCompanionRail, AiCompanionTrigger } from "./AiCompanionRail";
import {
  type AiCompanionLayoutController,
  useAiCompanionLayout,
} from "./ai-companion-layout";

/**
 * SAI-19 伴学栏视图壳（B10 必须先测⑤⑥⑦ 的组件层）：
 * - dock 面板在文档流内；窄屏退为浮层独立面板，不挤主区（结构证明：
 *   panel 模式下 rail 内只有主区一个子元素）；
 * - 入口不假报可连接：未连接如实显示并提供设置入口；已配置只显示
 *   真实通道状态，不渲染发送/对话能力；
 * - Esc 关闭与焦点返回触发按钮；reduced-motion 下打开不被动画等待阻塞；
 * - 回复区域与主区可分别阅读（aria 标记）。
 * 状态机见 ai-companion-layout.test；题卡 identity 集成见
 * attempt/AttemptWorkspace.ai-rail.test.tsx。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentAiConnectionsApi: vi.fn(),
  };
});
const mockedFetch = vi.mocked(fetchStudentAiConnectionsApi);

/** 宽度桩（同布局控制器测试） */
let widthValue = 1400;
let restoreWidthMocks: () => void;
function stubWidth() {
  const offset = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(() => widthValue);
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ width: widthValue, height: 100 }) as DOMRect);
  return () => {
    offset.mockRestore();
    rect.mockRestore();
  };
}
function setWidth(next: number) {
  widthValue = next;
  fireEvent(window, new Event("resize"));
}

const SETTINGS_HREF = "/s/settings/ai?from=%2Fs%2Fassignments%2Fa1";

const captured: { controller: AiCompanionLayoutController | null } = {
  controller: null,
};

function RailHarness({
  conversation,
  questionLabel = "第 3 题",
}: {
  conversation?: React.ReactNode;
  questionLabel?: string | null;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editor = useRef({ flush: vi.fn(async () => {}) });
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor: editor.current,
    currentQuestionId: "q1",
  });
  captured.controller = controller;
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AiCompanionTrigger ref={triggerRef} controller={controller} />
        <AiCompanionRail
          containerRef={railRef}
          controller={controller}
          triggerRef={triggerRef}
          questionLabel={questionLabel}
          settingsHref={SETTINGS_HREF}
          conversation={conversation}
        >
          <div data-testid="main-content">主区内容</div>
        </AiCompanionRail>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const openViaTrigger = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  });
};

beforeEach(() => {
  widthValue = 1400;
  restoreWidthMocks = stubWidth();
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
});
afterEach(() => {
  restoreWidthMocks();
  vi.unstubAllGlobals();
});

function inappConnection() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "inapp" as const,
    baseUrl: "https://api.example.com/v1",
    model: "glm-4",
    keyFingerprint: "ab12cd34",
    imageCapability: "unknown" as const,
    isDefault: true,
    verifyStatus: "verified" as const,
    verifiedAt: "2026-10-16T00:00:00Z",
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

describe("SAI-19 伴学栏视图壳", () => {
  it("必须先测⑤：dock 面板在文档流内；窄屏退为浮层独立面板且不再挤占主区", async () => {
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness />);
    await openViaTrigger();
    // 宽屏 dock：面板是 rail 的文档流内兄弟列（主区 + 面板）
    const rail = screen
      .getByTestId("main-content")
      .closest('[data-slot="ai-companion-rail"]') as HTMLElement;
    expect(rail).not.toBeNull();
    const dockPanel = screen.getByRole("complementary", { name: "AI 助教" });
    expect(rail.contains(dockPanel)).toBe(true);
    expect(rail.children.length).toBe(2);

    // 窄屏：面板经浮层（portal）呈现，rail 内只剩主区——主区宽度不再被挤
    setWidth(500);
    const overlayPanel = await screen.findByRole("dialog", { name: "AI 助教" });
    expect(rail.contains(overlayPanel)).toBe(false);
    expect(rail.children.length).toBe(1);
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
  });

  it("入口不假报可连接：未连接时面板如实显示未连接并提供设置入口", async () => {
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness />);
    await openViaTrigger();
    const panel = screen.getByRole("complementary", { name: "AI 助教" });
    expect(
      await within(panel).findByText("未连接 AI 服务"),
    ).toBeInTheDocument();
    const link = within(panel).getByRole("link", { name: "去设置连接" });
    expect(link).toHaveAttribute("href", SETTINGS_HREF);
    // 不渲染任何发送/对话动作，不宣称已连接
    expect(
      within(panel).queryByText(/已连接|已可连接/),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /发送/ })).toBeNull();
  });

  it("已配置连接只显示真实通道状态：通道数与默认模型，不宣称可发送", async () => {
    mockedFetch.mockResolvedValue({
      connections: [inappConnection()],
    } as AiConnectionListData);
    render(<RailHarness />);
    await openViaTrigger();
    const panel = screen.getByRole("complementary", { name: "AI 助教" });
    expect(
      await within(panel).findByText(/已配置 1 个 AI 通道/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/默认：glm-4/)).toBeInTheDocument();
    expect(within(panel).getByText(/发送与对话功能建设中/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /发送/ })).toBeNull();
  });

  it("必须先测⑥：reduced-motion 下打开不被动画等待阻塞；dock 面板 Esc 关闭并焦点返回触发按钮", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness />);
    const trigger = screen.getByRole("button", { name: "AI 助教" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await openViaTrigger();
    // 无动画等待：act 后面板同步可见，触发按钮状态随之翻转
    const panel = screen.getByRole("complementary", { name: "AI 助教" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    // 打开后焦点进入面板（关闭按钮）
    expect(panel.contains(document.activeElement)).toBe(true);
    // Esc 关闭：面板卸载，焦点返回触发按钮
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "AI 助教" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("必须先测⑥：窄屏独立面板 Esc 关闭并焦点返回触发按钮", async () => {
    widthValue = 500;
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness />);
    // 模态打开后主区进 aria-hidden，触发按钮先取引用再开面板
    const trigger = screen.getByRole("button", { name: "AI 助教" });
    await openViaTrigger();
    expect(
      await screen.findByRole("dialog", { name: "AI 助教" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(screen.queryByRole("dialog", { name: "AI 助教" })).toBeNull();
    // 焦点返回经微任务落回触发按钮（关闭后即到，无动画等待）
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("必须先测⑦：回复区域与主区可分别阅读（aria 标记齐全）", async () => {
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(
      <RailHarness
        conversation={
          <ul>
            {Array.from({ length: 30 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态合成子内容，无重排语义
              <li key={`合成对话-${i + 1}`}>合成对话 {i + 1}</li>
            ))}
          </ul>
        }
      />,
    );
    await openViaTrigger();
    expect(screen.getByRole("region", { name: "作答区" })).toBeInTheDocument();
    const conversation = screen.getByRole("region", {
      name: "本题对话记录",
    });
    // 合成子内容完整呈现（空间测试），不截断丢失
    expect(within(conversation).getAllByRole("listitem").length).toBe(30);
    expect(
      screen.getByRole("navigation", { name: "快捷按钮" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "当前材料" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "通道与模式" }),
    ).toBeInTheDocument();
  });

  it("未绑定题目时面板如实显示未绑定，不虚构题号", async () => {
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness questionLabel={null} />);
    await openViaTrigger();
    expect(screen.getByText("未绑定题目")).toBeInTheDocument();
  });
});
