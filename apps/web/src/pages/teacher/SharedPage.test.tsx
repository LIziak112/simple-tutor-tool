import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SharedFileList } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSharedFileApi,
  fetchSharedFiles,
  importSharedFile,
  previewSharedFile,
} from "@/lib/api";
import { SharedPage } from "./SharedPage";

/**
 * /t/shared 共享页测试（T2B.7 验收项「页面测试」）：
 * 文件卡片（标题/发布者/题数/相对时间）、来源标签（在线发布 / 本地文件）、
 * 搜索（前端即时过滤）、预览抽屉（动作清单 → 确认导入 → 成功提示）、
 * 删除按钮按权限显示（canDelete）+ 删除确认弹层。
 */

const apiMocks = vi.hoisted(() => ({
  fetchSharedFiles: vi.fn(),
  previewSharedFile: vi.fn(),
  importSharedFile: vi.fn(),
  deleteSharedFileApi: vi.fn(),
  fetchLibraryFolders: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSharedFiles: apiMocks.fetchSharedFiles,
    previewSharedFile: apiMocks.previewSharedFile,
    importSharedFile: apiMocks.importSharedFile,
    deleteSharedFileApi: apiMocks.deleteSharedFileApi,
    fetchLibraryFolders: apiMocks.fetchLibraryFolders,
  };
});

vi.mocked(fetchSharedFiles);
vi.mocked(previewSharedFile);
vi.mocked(importSharedFile);
vi.mocked(deleteSharedFileApi);

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
        canDelete: false,
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
      <SharedPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fetchLibraryFolders.mockResolvedValue({ folders: [] });
});

describe("SharedPage 文件卡片与来源标签", () => {
  it("渲染卡片：标题、发布者、题数、来源标签（在线发布 / 本地文件）", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    renderPage();

    expect(await screen.findByText("练习四")).toBeInTheDocument();
    expect(
      screen.getByText("练习四-teacher-20260930-120000.md"),
    ).toBeInTheDocument();
    expect(screen.getByText("teacher")).toBeInTheDocument();
    // 来源标签（§4.3）
    expect(
      screen.getAllByTestId("shared-source").map((el) => el.textContent),
    ).toEqual(["在线发布", "本地文件"]);
    // 本地文件无发布者行 → 显示「本地文件」文案
    expect(
      screen.getByText("本地文件", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("搜索：按标题/发布者即时过滤，无匹配显示空态提示", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    renderPage();
    await screen.findByText("练习四");

    fireEvent.change(screen.getByLabelText("搜索共享文件"), {
      target: { value: "练习四" },
    });
    expect(screen.getByText("练习四")).toBeInTheDocument();
    expect(screen.queryByText("第1讲 有理数")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索共享文件"), {
      target: { value: "不存在的文件" },
    });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  it("空目录显示空态引导（发布入口与本地放入说明）", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList({ files: [] }));
    renderPage();
    expect(await screen.findByText("共享目录还是空的")).toBeInTheDocument();
  });

  it("规模防线提示：truncated 与 oversizeHidden", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(
      fileList({ truncated: true, oversizeHidden: 2 }),
    );
    renderPage();
    expect(await screen.findByText(/仅显示前 200 个/)).toBeInTheDocument();
    expect(screen.getByText(/2 个超过 1MB 的文件未列出/)).toBeInTheDocument();
  });
});

describe("SharedPage 预览抽屉与导入", () => {
  it("点「导入到我的资源库」→ 抽屉展示统计与动作清单 → 确认导入成功", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.previewSharedFile.mockResolvedValue({
      version: 2,
      summary: {
        unitCount: 1,
        lectureCount: 0,
        questionCount: 8,
        typeDistribution: { judge: 8 },
      },
      issues: [],
      actions: [
        {
          kind: "createUnit",
          title: "练习四",
          unitId: "练习四",
          folderName: null,
          restore: false,
        },
      ],
      warnings: [],
    });
    apiMocks.importSharedFile.mockResolvedValue({
      units: [
        { id: "练习四", title: "练习四", inserted: true, updated: false },
      ],
      lectures: [],
      questions: { inserted: 8, updated: 0 },
      courseId: null,
      folderId: null,
    });
    renderPage();
    await screen.findByText("练习四");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "导入到我的资源库",
      })[0] as HTMLElement,
    );

    // 抽屉：统计条（版本徽章 + 题数）与动作清单（D19「将发生什么」）
    expect(await screen.findByText("DSL v2")).toBeInTheDocument();
    expect(screen.getByText(/新增单元「练习四」/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    expect(await screen.findByText(/导入完成/)).toBeInTheDocument();
    expect(apiMocks.importSharedFile).toHaveBeenCalledWith({
      filename: "练习四-teacher-20260930-120000.md",
    });
  });

  it("有 error 级 lint 时禁用「导入到我的资源库」并显示错误说明", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.previewSharedFile.mockResolvedValue({
      version: 2,
      summary: {
        unitCount: 1,
        lectureCount: 0,
        questionCount: 0,
        typeDistribution: {},
      },
      issues: [{ level: "error", line: 3, message: "题目缺少答案", rule: "X" }],
      actions: [],
      warnings: [],
    });
    renderPage();
    await screen.findByText("练习四");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "导入到我的资源库",
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(/无法导入/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  });
});

describe("SharedPage 查看预览抽屉", () => {
  it("点「预览」→ 抽屉渲染原文内容 → 「导入到我的资源库」切换到导入抽屉", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.previewSharedFile.mockResolvedValue({
      version: 2,
      summary: {
        unitCount: 1,
        lectureCount: 0,
        questionCount: 8,
        typeDistribution: { judge: 8 },
      },
      issues: [],
      actions: [
        {
          kind: "createUnit",
          title: "练习四",
          unitId: "练习四",
          folderName: null,
          restore: false,
        },
      ],
      warnings: [],
      markdown: "# 练习四\n\n有理数加减混合练习。\n",
    });
    renderPage();
    await screen.findByText("练习四");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^预览共享文件/,
      })[0] as HTMLElement,
    );
    // 渲染抽屉：原文经 RichMarkdown 渲染出正文段落
    expect(await screen.findByText("有理数加减混合练习。")).toBeInTheDocument();

    // 切换到导入抽屉：出现导入专属的目标文件夹选择
    fireEvent.click(screen.getByRole("button", { name: "导入到我的资源库" }));
    expect(await screen.findByText("导入到文件夹")).toBeInTheDocument();
  });

  it("预览：有 error 级 lint 时提示导入会被拒绝，内容仍可查看", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.previewSharedFile.mockResolvedValue({
      version: 2,
      summary: {
        unitCount: 1,
        lectureCount: 0,
        questionCount: 0,
        typeDistribution: {},
      },
      issues: [{ level: "error", line: 3, message: "题目缺少答案", rule: "X" }],
      actions: [],
      warnings: [],
      markdown: "# 练习四\n\n题目内容。\n",
    });
    renderPage();
    await screen.findByText("练习四");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^预览共享文件/,
      })[0] as HTMLElement,
    );
    expect(await screen.findByText(/1 个错误级问题/)).toBeInTheDocument();
    expect(screen.getByText("题目内容。")).toBeInTheDocument();
  });

  it("预览加载失败：展示错误与重试按钮", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.previewSharedFile.mockRejectedValue(new Error("共享文件不存在"));
    renderPage();
    await screen.findByText("练习四");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^预览共享文件/,
      })[0] as HTMLElement,
    );
    expect(await screen.findByText("共享文件不存在")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("SharedPage 删除权限（canDelete）", () => {
  it("canDelete=false（本地文件）不显示删除按钮；canDelete=true 显示并走确认弹层", async () => {
    apiMocks.fetchSharedFiles.mockResolvedValue(fileList());
    apiMocks.deleteSharedFileApi.mockResolvedValue(null);
    renderPage();
    await screen.findByText("练习四");

    // 本地文件（第 2 张卡片）无删除按钮；发布的（第 1 张）有
    expect(
      screen.getAllByRole("button", { name: /^删除共享文件/ }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^删除共享文件/ }));
    // 确认弹层注明「已导入的资源不受影响」（§4.2）
    expect(screen.getByText("删除共享文件？")).toBeInTheDocument();
    expect(
      screen.getByText(/已导入进资源库的内容不受影响/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(apiMocks.deleteSharedFileApi).toHaveBeenCalledWith(
        "练习四-teacher-20260930-120000.md",
      ),
    );
    expect(await screen.findByText("已删除共享文件")).toBeInTheDocument();
  });
});
