import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SharedFileList } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAdminSharedFileApi, fetchAdminSharedFiles } from "@/lib/api";
import { AdminSharedFilesPage } from "./AdminSharedFilesPage";

/**
 * /a/shared-files 管理端共享文件页测试（T2B.7 验收项「管理端加共享文件页签」）：
 * 列表与来源标签（在线发布 / 本地文件）、搜索、删除确认弹层
 * （管理员可删任意含本地文件；「已导入的资源不受影响」§4.2）、空态。
 */

const apiMocks = vi.hoisted(() => ({
  fetchAdminSharedFiles: vi.fn(),
  deleteAdminSharedFileApi: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAdminSharedFiles: apiMocks.fetchAdminSharedFiles,
    deleteAdminSharedFileApi: apiMocks.deleteAdminSharedFileApi,
  };
});

vi.mocked(fetchAdminSharedFiles);
vi.mocked(deleteAdminSharedFileApi);

function fileList(overrides: Partial<SharedFileList> = {}): SharedFileList {
  return {
    files: [
      {
        filename: "练习四-teacher-20260930-120000.md",
        kind: "practice",
        title: "练习四",
        questionCount: 8,
        publisher: "teacher",
        publishedAt: "2026-09-30T04:00:00.000Z",
        source: "published",
        canDelete: true,
      },
      {
        filename: "本地讲义.md",
        kind: "lecture",
        title: "第1讲 有理数",
        questionCount: 0,
        publisher: null,
        publishedAt: "2026-09-29T04:00:00.000Z",
        source: "local",
        canDelete: true,
      },
    ],
    truncated: false,
    oversizeHidden: 0,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminSharedFilesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminSharedFilesPage 列表与删除", () => {
  it("渲染文件卡片：来源标签（在线发布 / 本地文件）、发布者、搜索过滤", async () => {
    apiMocks.fetchAdminSharedFiles.mockResolvedValue(fileList());
    renderPage();

    expect(await screen.findByText("练习四")).toBeInTheDocument();
    expect(
      screen.getAllByTestId("shared-source").map((el) => el.textContent),
    ).toEqual(["在线发布", "本地文件"]);

    // 搜索（前端即时过滤）
    fireEvent.change(screen.getByLabelText("搜索共享文件"), {
      target: { value: "本地讲义" },
    });
    expect(screen.queryByText("练习四")).not.toBeInTheDocument();
    expect(screen.getByText("第1讲 有理数")).toBeInTheDocument();
  });

  it("空目录显示空态引导", async () => {
    apiMocks.fetchAdminSharedFiles.mockResolvedValue(fileList({ files: [] }));
    renderPage();
    expect(await screen.findByText("共享目录还是空的")).toBeInTheDocument();
  });

  it("删除任意文件（含本地）：确认弹层注明影响 → 确认后调用接口", async () => {
    apiMocks.fetchAdminSharedFiles.mockResolvedValue(fileList());
    apiMocks.deleteAdminSharedFileApi.mockResolvedValue(null);
    renderPage();
    await screen.findByText("练习四");

    // 本地文件也可删（管理员视角：两行都有删除按钮）
    const deleteButtons = screen.getAllByRole("button", {
      name: /^删除共享文件/,
    });
    expect(deleteButtons).toHaveLength(2);

    fireEvent.click(deleteButtons[1] as HTMLElement);
    expect(screen.getByText("删除共享文件？")).toBeInTheDocument();
    expect(
      screen.getByText(/已导入进资源库的内容不受影响/),
    ).toBeInTheDocument();
    expect(screen.getByText(/以管理员身份删除/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(apiMocks.deleteAdminSharedFileApi).toHaveBeenCalledWith(
        "本地讲义.md",
      ),
    );
    expect(await screen.findByText(/已删除 本地讲义.md/)).toBeInTheDocument();
  });
});
