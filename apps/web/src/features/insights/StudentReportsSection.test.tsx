import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReportListData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentReportsSection } from "@/features/insights/StudentReportsSection";
import {
  deleteReportApi,
  fetchReportDetail,
  fetchStudentReports,
} from "@/lib/api";

/**
 * 学生画像页「AI 报告」区组件测试（T4.7，D24——T4.2 占位换实数据）：
 * - 三态：加载 / 空态（说明 AI 经 MCP save_report 保存 + 连接入口）/ 错误重试；
 * - 列表：标题、来源徽章（MCP / 手动）、创建时间；
 * - 点开行按需取详情 → Markdown 渲染（RichMarkdown 输出标题元素）；
 * - 删除：确认弹层（标题回显）→ 确认调用 DELETE → 列表失效重取；取消不调用。
 * API 层 mock（服务端流转由路由测试覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentReports: vi.fn(),
    fetchReportDetail: vi.fn(),
    deleteReportApi: vi.fn(),
  };
});

const mockedList = vi.mocked(fetchStudentReports);
const mockedDetail = vi.mocked(fetchReportDetail);
const mockedDelete = vi.mocked(deleteReportApi);

const STUDENT = "22222222-2222-4222-8222-222222222222";

function makeReports(): ReportListData {
  return {
    reports: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        studentId: STUDENT,
        title: "薄弱点诊断（两周）",
        source: "mcp",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        studentId: STUDENT,
        title: "家长沟通摘要",
        source: "manual",
        createdAt: "2026-09-28T08:00:00.000Z",
      },
    ],
  };
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StudentReportsSection studentId={STUDENT} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue(makeReports());
});

describe("StudentReportsSection（T4.7 D24）", () => {
  it("空态：说明报告来源与连接入口（不出现占位旧文案）", async () => {
    mockedList.mockResolvedValue({ reports: [] });
    renderSection();

    expect(await screen.findByText("还没有 AI 报告")).toBeVisible();
    expect(
      screen.getByText(/AI 基于这名学生的学情数据写出的诊断与建议/),
    ).toBeVisible();
    const link = screen.getByRole("link", { name: "连接 AI" });
    expect(link.getAttribute("href")).toBe("/t/connect");
    expect(screen.queryByText("AI 报告将在连接 AI 后出现")).toBeNull();
  });

  it("列表：标题 + 来源徽章（MCP / 手动）+ 创建时间（北京时间）", async () => {
    renderSection();

    expect(await screen.findByText("薄弱点诊断（两周）")).toBeVisible();
    expect(screen.getByText("家长沟通摘要")).toBeVisible();
    expect(screen.getByText("MCP")).toBeVisible();
    expect(screen.getByText("手动")).toBeVisible();
    // formatCnTime 北京时间渲染（2026-10-01T08:00Z → 2026年10月1日 16:00:00）
    expect(screen.getByText(/2026年10月1日 16:00:00/)).toBeVisible();
    expect(screen.getByText(/2026年9月28日/)).toBeVisible();
  });

  it("点开行按需取详情并渲染 Markdown；未展开不请求正文", async () => {
    mockedDetail.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      studentId: STUDENT,
      title: "薄弱点诊断（两周）",
      source: "mcp",
      createdAt: "2026-10-01T08:00:00.000Z",
      markdown: "# 诊断结论\n\n有理数加法需要巩固。",
    });
    renderSection();

    expect(await screen.findByText("薄弱点诊断（两周）"));
    expect(mockedDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("薄弱点诊断（两周）"));
    expect(
      await screen.findByRole("heading", { name: "诊断结论" }),
    ).toBeVisible();
    expect(screen.getByText("有理数加法需要巩固。")).toBeVisible();
    expect(mockedDetail).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    );
  });

  it("删除走确认弹层：回显标题，取消不调用、确认调用并失效列表", async () => {
    mockedDelete.mockResolvedValue(null);
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "删除报告 薄弱点诊断（两周）",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeVisible();
    expect(screen.getByText("删除这份报告？")).toBeVisible();
    // 标题回显：弹层内（列表行仍各有一份，用 getAllByText 计数）
    expect(screen.getAllByText("薄弱点诊断（两周）").length).toBe(2);
    expect(mockedDelete).not.toHaveBeenCalled();

    // 取消：不调用
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(mockedDelete).not.toHaveBeenCalled();

    // 再开 → 确认：调用 DELETE；列表失效后重取（mock 恒同值，断言调用次数增长）
    fireEvent.click(
      screen.getByRole("button", { name: "删除报告 薄弱点诊断（两周）" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      );
    });
    await waitFor(() => {
      expect(mockedList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("列表错误态：错误文案 + 重试", async () => {
    mockedList.mockRejectedValue(new Error("报告接口挂了"));
    renderSection();

    expect(await screen.findByText("报告接口挂了")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(mockedList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
