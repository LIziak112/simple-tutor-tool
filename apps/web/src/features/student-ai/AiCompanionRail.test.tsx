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
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentAiConnectionsApi } from "@/lib/api";
import { stubElementWidth } from "@/test/stub-element-width";
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

/** 宽度桩（@/test/stub-element-width，与布局控制器测试共用） */
let width: ReturnType<typeof stubElementWidth>;
const setWidth = (next: number) => width.setWidth(next);

const SETTINGS_HREF = "/s/settings/ai?from=%2Fs%2Fassignments%2Fa1";

const captured: { controller: AiCompanionLayoutController | null } = {
  controller: null,
};

function RailHarness({
  conversation,
  status,
  composer,
  questionLabel = "第 3 题",
}: {
  conversation?: React.ReactNode;
  status?: React.ReactNode;
  composer?: React.ReactNode;
  questionLabel?: string | null;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editor = useRef({ flush: vi.fn(async () => {}) });
  // 惰性初始化：控制器状态变化引起重渲染时不重建 client（避免缓存清零
  // 重发请求与 QueryClient 定时器成倍分配）
  const [queryClient] = useState(() => new QueryClient());
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor: editor.current,
    currentQuestionId: "q1",
  });
  captured.controller = controller;
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AiCompanionTrigger ref={triggerRef} controller={controller} />
        <AiCompanionRail
          containerRef={railRef}
          controller={controller}
          triggerRef={triggerRef}
          questionLabel={questionLabel}
          settingsHref={SETTINGS_HREF}
          status={status}
          composer={composer}
          conversation={conversation}
        >
          <div data-testid="main-content">主区内容</div>
        </AiCompanionRail>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function TriggerPairHarness() {
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editor = useRef({ flush: vi.fn(async () => {}) });
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor: editor.current,
    currentQuestionId: "q1",
  });
  return (
    <div ref={railRef}>
      <AiCompanionTrigger
        ref={triggerRef}
        controller={controller}
        label="第 1 题 AI 助教"
        expanded={controller.open}
      />
      <AiCompanionTrigger
        controller={controller}
        label="第 2 题 AI 助教"
        expanded={false}
      />
    </div>
  );
}

const openViaTrigger = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "AI 助教" }));
  });
};

beforeEach(() => {
  width = stubElementWidth();
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
  width.restore();
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

function mcpConnection() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    channel: "mcp" as const,
    tokenFingerprint: "ab12cd34",
    isDefault: true,
    verifyStatus: "unverified" as const,
    verifiedAt: null,
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
    // 宽屏 dock：横向分栏，但主区保持 min-w-0 flex-1 可收缩，不撑出横向溢出
    expect(rail.className).toContain("flex-row");
    const mainSection = rail.querySelector("section[aria-label='作答区']");
    expect(mainSection?.className).toContain("min-w-0");

    // 窄屏：面板经浮层（portal）呈现，rail 内只剩主区——主区宽度不再被挤
    setWidth(500);
    const overlayPanel = await screen.findByRole("dialog", { name: "AI 助教" });
    expect(rail.contains(overlayPanel)).toBe(false);
    expect(rail.children.length).toBe(1);
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
    // 无横向溢出的结构性保障：窄屏后 rail 不再横向分栏（flex-col），
    // 固定宽度的 AI 面板完全退出文档流，主区独占整行宽度
    expect(rail.className).toContain("flex-col");
    expect(rail.className).not.toContain("flex-row");
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

  it("mcp/link 默认通道按统一通道名显示，不虚构模型", async () => {
    mockedFetch.mockResolvedValue({
      connections: [mcpConnection()],
    } as AiConnectionListData);
    render(<RailHarness />);
    await openViaTrigger();
    const panel = screen.getByRole("complementary", { name: "AI 助教" });
    // 标签来自 CHANNEL_LABEL 单源（与连接管理页一致），不显示不存在的 model
    expect(
      await within(panel).findByText(/默认：MCP 工具/),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/默认：undefined/),
    ).not.toBeInTheDocument();
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
    setWidth(500);
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
    expect(conversation).toHaveAttribute("data-slot", "ai-reply-workspace");
    expect(within(conversation).getByText("AI 回复与进展")).toBeInTheDocument();
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

  it("题卡入口选中态按题目局部计算，重复点击当前题可取消", async () => {
    render(<TriggerPairHarness />);
    const first = screen.getByRole("button", { name: "第 1 题 AI 助教" });
    const second = screen.getByRole("button", { name: "第 2 题 AI 助教" });
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(first);
    });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(first);
    });
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("aria-pressed", "false");
  });

  it("未绑定题目时面板如实显示未绑定，不虚构题号", async () => {
    mockedFetch.mockResolvedValue({ connections: [] } as AiConnectionListData);
    render(<RailHarness questionLabel={null} />);
    await openViaTrigger();
    expect(screen.getByText("未绑定题目")).toBeInTheDocument();
  });

  it("SAI-20 会话注入：status/composer 顶替合成通道状态与新增输入区，未注入时保留合成回退", async () => {
    mockedFetch.mockResolvedValue({
      connections: [inappConnection()],
    } as AiConnectionListData);
    render(
      <RailHarness
        status={<div>真实状态区</div>}
        composer={<div>真实输入区</div>}
      />,
    );
    await openViaTrigger();
    const panel = screen.getByRole("complementary", { name: "AI 助教" });
    // 注入的会话区进入对应分区；合成通道状态不再重复出现
    expect(await within(panel).findByText("真实状态区")).toBeInTheDocument();
    expect(within(panel).getByText("真实输入区")).toBeInTheDocument();
    expect(
      within(panel).queryByText(/发送与对话功能建设中/),
    ).not.toBeInTheDocument();
    const inputSection = within(panel).getByRole("region", {
      name: "发送输入",
    });
    expect(within(inputSection).getByText("真实输入区")).toBeInTheDocument();
  });
});
