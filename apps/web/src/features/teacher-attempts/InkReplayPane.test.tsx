import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchTeacherInkStrokesApi } from "@/lib/api";
import { InkReplayPane } from "./InkReplayPane.tsx";

/**
 * InkReplayPane（T3.3 教师端回放三态）测试：
 * 加载中 / 矢量数据可用（渲染 InkReplay 控件）/ 失败或解析失败降级 PNG + 提示。
 * API 层与 canvas 绘制薄层 mock（真实接口行为由服务端集成测试覆盖；
 * 真实绘制不可在 jsdom 验证）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchTeacherInkStrokesApi: vi.fn(),
  };
});

// jsdom 无 canvas 2d context：InkReplay 的绘制薄层 mock（控制逻辑另有专测）
vi.mock("@/features/ink/replay/draw.ts", () => ({
  createAtramentReplayCanvas: () => ({
    drawFrame: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const mockedFetch = vi.mocked(fetchTeacherInkStrokesApi);

/** 合法 atrament 矢量文档（带时间戳） */
const ATRAMENT_DOC = {
  engine: "atrament",
  version: 1,
  data: {
    width: 1000,
    strokes: [
      {
        tool: "pen",
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10, y: 10, p: 0.5, t: 0 },
          { x: 60, y: 40, p: 0.6, t: 120 },
        ],
      },
    ],
  },
  updatedAt: 1,
};

function renderPane(hasStrokes?: boolean): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <InkReplayPane
        inkId="dddddddd-dddd-4ddd-8ddd-dddddddd0001"
        pngUrl="/api/teacher/ink/dddddddd-dddd-4ddd-8ddd-dddddddd0001.png"
        alt="第 2 题的手写笔迹"
        {...(hasStrokes === undefined ? {} : { hasStrokes })}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("InkReplayPane 三态（D12）", () => {
  it("加载中：spinner 文案，不白屏", () => {
    mockedFetch.mockReturnValue(new Promise(() => undefined));
    renderPane();
    expect(screen.getByText("正在加载回放数据…")).toBeInTheDocument();
  });

  it("矢量数据可用：渲染 InkReplay 播放控件", async () => {
    mockedFetch.mockResolvedValue(ATRAMENT_DOC);
    renderPane();
    expect(
      await screen.findByRole("button", { name: "播放" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: "回放进度" }),
    ).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      "dddddddd-dddd-4ddd-8ddd-dddddddd0001",
    );
  });

  it("接口 404（文件缺失）：降级显示 PNG 快照 + 「无回放数据」提示与原因", async () => {
    mockedFetch.mockRejectedValue(
      new ApiError("INK_NOT_FOUND", "笔迹矢量数据不存在", 404),
    );
    renderPane();
    expect(
      await screen.findByText("无回放数据，已显示快照图片"),
    ).toBeInTheDocument();
    expect(screen.getByText("（笔迹矢量数据不存在）")).toBeInTheDocument();
    expect(screen.getByAltText("第 2 题的手写笔迹")).toHaveAttribute(
      "src",
      "/api/teacher/ink/dddddddd-dddd-4ddd-8ddd-dddddddd0001.png",
    );
  });

  it("数据可取回但解析失败（非法结构）：同样走降级", async () => {
    mockedFetch.mockResolvedValue({ engine: "atrament", version: 9 });
    renderPane();
    expect(
      await screen.findByText("无回放数据，已显示快照图片"),
    ).toBeInTheDocument();
    expect(screen.getByAltText("第 2 题的手写笔迹")).toBeInTheDocument();
  });

  it("hasStrokes=false（实测跟进）：不发起矢量请求，直接降级并注明「该题未书写笔迹」", () => {
    // mock 有值也不该被取用——断言零调用即证明查询从未发出（消除服务端 404 噪声）
    mockedFetch.mockResolvedValue(ATRAMENT_DOC);
    renderPane(false);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(screen.getByText("无回放数据，已显示快照图片")).toBeInTheDocument();
    expect(screen.getByText("（该题未书写笔迹）")).toBeInTheDocument();
    expect(screen.getByAltText("第 2 题的手写笔迹")).toHaveAttribute(
      "src",
      "/api/teacher/ink/dddddddd-dddd-4ddd-8ddd-dddddddd0001.png",
    );
  });
});
