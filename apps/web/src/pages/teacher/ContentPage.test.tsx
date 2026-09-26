import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ContentTree } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchContentTree } from "@/lib/api";
import ContentPage from "./ContentPage";

/**
 * 内容页组件测试（T1.11）：三态齐全（加载/错误/空态引导）、
 * 课程分组渲染（讲义行 + 可展开单元的题目摘要表）、导入成功提示条。
 * API 层 mock（真实接口行为由后端集成测试覆盖）。
 */

vi.mock("@/lib/api", () => ({
  fetchContentTree: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchContentTree);

/** 包 Router + QueryClient 渲染页面 */
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/content"]}>
        <ContentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TREE: ContentTree = {
  courses: [
    {
      id: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      title: "默认课程",
      lectures: [
        {
          id: "e70cb1f8-98a4-4f6a-8a5e-2b64e64b28b4",
          title: "第1讲 有理数",
          updatedAt: "2026-09-26T00:00:00.000Z",
        },
      ],
      units: [
        {
          id: "练习四",
          title: "练习四",
          topic: "有理数加减混合",
          updatedAt: "2026-09-26T00:00:00.000Z",
          questions: [
            {
              id: "练习四-1",
              type: "judge",
              difficulty: 1,
              knowledge: ["有理数的概念"],
              version: 2,
            },
            {
              id: "p4-q7",
              type: "solve",
              difficulty: 3,
              knowledge: [],
              version: 1,
            },
          ],
        },
      ],
    },
  ],
};

describe("ContentPage 三态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("加载中显示骨架屏与提示，不白屏", () => {
    mockedFetch.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("正在加载内容…")).toBeInTheDocument();
  });

  it("加载失败显示错误原因与重试按钮，重试重新请求", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("连不上服务器"));
    renderPage();
    expect(await screen.findByText("内容加载失败")).toBeInTheDocument();
    expect(screen.getByText("连不上服务器")).toBeInTheDocument();
    mockedFetch.mockResolvedValue(TREE);
    screen.getByRole("button", { name: "重试" }).click();
    await screen.findByText("第1讲 有理数");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("空树显示空态并引导去导入页（链接指向 /t/import）", async () => {
    mockedFetch.mockResolvedValue({ courses: [] });
    renderPage();
    expect(await screen.findByText("还没有导入任何内容")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /去导入第一份文档/ });
    expect(link.getAttribute("href")).toBe("/t/import");
  });
});

describe("ContentPage 内容树渲染", () => {
  beforeEach(() => {
    mockedFetch.mockResolvedValue(TREE);
  });

  it("课程分组、讲义行与单元行（topic、题数）正确显示", async () => {
    renderPage();
    expect(await screen.findByText("默认课程")).toBeInTheDocument();
    expect(screen.getByText("第1讲 有理数")).toBeInTheDocument();
    expect(screen.getByText("练习四")).toBeInTheDocument();
    expect(screen.getByText("有理数加减混合")).toBeInTheDocument();
    expect(screen.getByText(/2 题/)).toBeInTheDocument();
  });

  it("点开单元显示题目摘要：题号、题型中文徽章、难度、考点、版本", async () => {
    renderPage();
    // 单元 summary 是 <summary> 元素，点击展开
    const summary = await screen.findByText("练习四");
    summary.closest("summary")?.click();

    expect(await screen.findByText("练习四-1")).toBeInTheDocument();
    expect(screen.getByText("判断")).toBeInTheDocument();
    expect(screen.getByText("计算")).toBeInTheDocument();
    expect(screen.getByText("★★★")).toBeInTheDocument();
    expect(screen.getByText("有理数的概念")).toBeInTheDocument();
    expect(screen.getAllByText("v1").length).toBeGreaterThan(0);
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("导入成功跳转携带的提示条会显示（location.state.importSuccess），点 × 收起", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            {
              pathname: "/t/content",
              state: { importSuccess: "导入完成：新增 8 题" },
            },
          ]}
        >
          <ContentPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("导入完成：新增 8 题")).toBeInTheDocument();
    screen.getByRole("button", { name: "关闭提示" }).click();
    await waitFor(() =>
      expect(screen.queryByText("导入完成：新增 8 题")).not.toBeInTheDocument(),
    );
  });
});
