import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContentTree } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCourseApi,
  deleteCourseApi,
  deleteQuestionApi,
  fetchContentTree,
  fetchQuestionDetail,
  updateCourseApi,
} from "@/lib/api";
import ContentPage from "./ContentPage";

/**
 * 内容页组件测试（T1.11 三态与渲染；T1.12 课程 CRUD、编辑/删除入口）。
 * API 层 mock（真实接口行为由后端集成测试覆盖）；
 * 排序的顺序计算与 payload 构造在 reorder-logic.test.ts 纯测覆盖。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchContentTree: vi.fn(),
    fetchQuestionDetail: vi.fn(),
    fetchLectureDetail: vi.fn(),
    createCourseApi: vi.fn(),
    updateCourseApi: vi.fn(),
    deleteCourseApi: vi.fn(),
    deleteQuestionApi: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchContentTree);
const mockedFetchQuestion = vi.mocked(fetchQuestionDetail);
const mockedCreateCourse = vi.mocked(createCourseApi);
const mockedUpdateCourse = vi.mocked(updateCourseApi);
const mockedDeleteCourse = vi.mocked(deleteCourseApi);
const mockedDeleteQuestion = vi.mocked(deleteQuestionApi);

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
    {
      id: "a11d0c3e-2f2b-4c0f-9f60-3f2a1b0c9d01",
      title: "初一上",
      lectures: [],
      units: [],
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

describe("ContentPage 课程管理（T1.12）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(TREE);
  });

  it("新建课程：弹层输入课程名 → 调 createCourseApi 并刷新", async () => {
    mockedCreateCourse.mockResolvedValue({
      id: "7c1b1c56-0000-4000-8000-000000000001",
      title: "初一下",
      order: 2,
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /新建课程/ }));

    const input = await screen.findByLabelText("课程名");
    fireEvent.change(input, { target: { value: "初一下" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(mockedCreateCourse).toHaveBeenCalled());
    expect(mockedCreateCourse.mock.calls[0]?.[0]).toEqual({ title: "初一下" });
    // 成功后弹层关闭
    await waitFor(() =>
      expect(screen.queryByLabelText("课程名")).not.toBeInTheDocument(),
    );
  });

  it("课程行内重命名：铅笔 → 输入新名 → 保存调 updateCourseApi（PATCH）", async () => {
    mockedUpdateCourse.mockResolvedValue({
      id: "a11d0c3e-2f2b-4c0f-9f60-3f2a1b0c9d01",
      title: "初一上学期",
      order: 1,
    });
    renderPage();
    await screen.findByText("初一上");
    fireEvent.click(screen.getByRole("button", { name: "重命名课程 初一上" }));
    const input = screen.getByLabelText("课程「初一上」的新名称");
    fireEvent.change(input, { target: { value: "初一上学期" } });
    fireEvent.click(screen.getByRole("button", { name: "保存课程名" }));

    await waitFor(() => expect(mockedUpdateCourse).toHaveBeenCalled());
    expect(mockedUpdateCourse.mock.calls[0]?.[1]).toEqual({
      title: "初一上学期",
    });
  });

  it("删除课程：有内容的课程按钮禁用；空课程确认后调 deleteCourseApi", async () => {
    renderPage();
    await screen.findByText("初一上");
    // 默认课程有讲义/单元 → 禁用并带提示
    expect(
      screen.getByRole("button", { name: "删除课程 默认课程" }),
    ).toBeDisabled();
    // 空课程可删：确认弹层 → 确认删除
    fireEvent.click(screen.getByRole("button", { name: "删除课程 初一上" }));
    expect(await screen.findByText("删除课程")).toBeInTheDocument();
    // 弹层内展示被删对象名（课程行 + 弹层各出现一次）
    expect(screen.getAllByText("初一上").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mockedDeleteCourse).toHaveBeenCalled());
    expect(mockedDeleteCourse.mock.calls[0]?.[0]).toBe(
      "a11d0c3e-2f2b-4c0f-9f60-3f2a1b0c9d01",
    );
  });
});

describe("ContentPage 单条编辑与删除入口（T1.12）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(TREE);
  });

  it("题目行：编辑打开抽屉（按 id 取原文）；删除走确认弹层（软删语义文案）", async () => {
    mockedFetchQuestion.mockResolvedValue({
      id: "练习四-1",
      unitId: "练习四",
      order: 0,
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
      sourceMd: "::::question{type=judge difficulty=1}\n题干。[[正确]]\n::::",
      version: 2,
    });
    renderPage();
    // 展开单元
    (await screen.findByText("练习四")).closest("summary")?.click();

    // 编辑 → 抽屉打开并按 id 取原文
    fireEvent.click(screen.getByRole("button", { name: "编辑题目 练习四-1" }));
    await screen.findByText("编辑题目");
    await waitFor(() =>
      expect(mockedFetchQuestion).toHaveBeenCalledWith("练习四-1"),
    );
    // 关闭抽屉再测删除
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByText("编辑题目")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "删除题目 练习四-1" }));
    expect(await screen.findByText("删除题目")).toBeInTheDocument();
    // 软删语义文案
    expect(
      screen.getByText(/历史作答与统计保留，重新导入包含该题的文档即可恢复/),
    ).toBeInTheDocument();
    mockedDeleteQuestion.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mockedDeleteQuestion).toHaveBeenCalled());
    expect(mockedDeleteQuestion.mock.calls[0]?.[0]).toBe("练习四-1");
  });

  it("讲义行：编辑打开讲义抽屉", async () => {
    const { fetchLectureDetail } = await import("@/lib/api");
    const mockedFetchLecture = vi.mocked(fetchLectureDetail);
    mockedFetchLecture.mockResolvedValue({
      id: "e70cb1f8-98a4-4f6a-8a5e-2b64e64b28b4",
      title: "第1讲 有理数",
      markdown: "# 第1讲 有理数\n\n正文",
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑讲义 第1讲 有理数" }),
    );
    await screen.findByText("编辑讲义");
    expect(mockedFetchLecture).toHaveBeenCalledWith(
      "e70cb1f8-98a4-4f6a-8a5e-2b64e64b28b4",
    );
  });
});
