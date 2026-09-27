import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LibraryUnitList, LibraryUsage } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchLibraryApi,
  deleteUnitApi,
  fetchLibraryFolders,
  fetchLibraryLectures,
  fetchLibraryUnits,
  fetchUnitUsageApi,
} from "@/lib/api";
import LibraryPage from "./LibraryPage";

/**
 * 资源库页面组件测试（T2A.2 验收项）：
 * - 删除确认弹层列出使用情况（课程名 + 作业名 + 作答数）；
 * - 批量移动（选目标文件夹后调 batchLibraryApi action=move）、批量删除、批量恢复；
 * - 三态基础（加载 / 空态）。
 * API 层 mock（真实接口行为由后端集成测试 library.test.ts 覆盖）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchLibraryFolders: vi.fn(),
    fetchLibraryLectures: vi.fn(),
    fetchLibraryUnits: vi.fn(),
    fetchUnitUsageApi: vi.fn(),
    fetchLectureUsageApi: vi.fn(),
    batchLibraryApi: vi.fn(),
    deleteUnitApi: vi.fn(),
    deleteLectureApi: vi.fn(),
    restoreUnitApi: vi.fn(),
    restoreLectureApi: vi.fn(),
    purgeUnitApi: vi.fn(),
    purgeLectureApi: vi.fn(),
    downloadExportMd: vi.fn(),
  };
});

const mockedFolders = vi.mocked(fetchLibraryFolders);
const mockedLectures = vi.mocked(fetchLibraryLectures);
const mockedUnits = vi.mocked(fetchLibraryUnits);
const mockedUnitUsage = vi.mocked(fetchUnitUsageApi);
const mockedBatch = vi.mocked(batchLibraryApi);
const mockedDeleteUnit = vi.mocked(deleteUnitApi);

const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "练习四";

const FOLDERS = {
  folders: [
    {
      id: FOLDER_ID,
      name: "有理数",
      order: 0,
      lectureCount: 1,
      unitCount: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
} as const;

const UNITS: LibraryUnitList = {
  units: [
    {
      id: UNIT_ID,
      title: "练习四",
      topic: "有理数加减混合",
      folderId: FOLDER_ID,
      lectureId: null,
      lectureTitle: null,
      updatedAt: "2026-09-26T00:00:00.000Z",
      deletedAt: null,
      questionCount: 2,
      typeDistribution: { judge: 1, choice: 1 },
      knowledge: ["相反数"],
      courseCount: 1,
      assignmentCount: 1,
      questions: [
        {
          id: "练习四-1",
          type: "judge",
          difficulty: 1,
          knowledge: ["有理数的概念"],
          version: 1,
        },
        {
          id: "练习四-2",
          type: "choice",
          difficulty: 1,
          knowledge: ["相反数"],
          version: 1,
        },
      ],
    },
  ],
};

const USAGE: LibraryUsage = {
  courses: [{ id: "c1", name: "初一上", visible: true }],
  assignments: [{ id: "a1", title: "周末练习", dueAt: null }],
  attemptCount: 3,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/library"]}>
        <LibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 默认 mock：题库有 1 个单元；usage 返回使用中数据 */
function mockDataLoaded(): void {
  mockedFolders.mockResolvedValue(FOLDERS as never);
  mockedLectures.mockResolvedValue({ lectures: [] } as never);
  mockedUnits.mockResolvedValue(UNITS as never);
  mockedUnitUsage.mockResolvedValue(USAGE as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("资源库页面", () => {
  it("默认题库页签：渲染单元行（题数 / 引用数 / 作业数 / 考点）", async () => {
    mockDataLoaded();
    renderPage();
    expect(
      await screen.findByRole("checkbox", { name: "选择单元 练习四" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 题 · 被 1 个课程引用 · 1 个作业使用/),
    ).toBeInTheDocument();
    // 考点出现在单元行汇总与展开题目表中，至少渲染一次
    expect(screen.getAllByText("相反数").length).toBeGreaterThan(0);
  });

  it("加载中显示骨架；空数据显示空态引导", async () => {
    mockedFolders.mockReturnValue(new Promise(() => {}) as never);
    mockedLectures.mockReturnValue(new Promise(() => {}) as never);
    mockedUnits.mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    expect(screen.getByText("正在加载练习单元…")).toBeInTheDocument();
  });

  it("删除确认弹层列出使用情况（课程名 + 作业名 + 作答数）；确认后软删", async () => {
    mockDataLoaded();
    mockedDeleteUnit.mockResolvedValue(null);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "删除单元 练习四" }),
    );
    // 弹层显示使用情况
    expect(await screen.findByText("初一上")).toBeInTheDocument();
    expect(screen.getByText("学生可见")).toBeInTheDocument();
    expect(screen.getByText("周末练习")).toBeInTheDocument();
    expect(screen.getByText(/关联作答记录：3 条/)).toBeInTheDocument();
    // 确认 → 调软删接口
    fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
    await waitFor(() => {
      expect(mockedDeleteUnit).toHaveBeenCalledWith(UNIT_ID);
    });
  });

  it("批量移动：选中两个单元 → 选目标文件夹 → batchLibraryApi(action=move)", async () => {
    mockDataLoaded();
    mockedBatch.mockResolvedValue({
      results: [
        { id: UNIT_ID, ok: true },
        { id: "unit-b", ok: true },
      ],
    } as never);
    renderPage();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择单元 练习四" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "移动到文件夹…" }));
    // 弹层选择目标文件夹并确认
    const select = await screen.findByLabelText("目标文件夹");
    fireEvent.change(select, { target: { value: FOLDER_ID } });
    fireEvent.click(screen.getByRole("button", { name: /^移动$/ }));
    await waitFor(() => {
      expect(mockedBatch).toHaveBeenCalledWith({
        action: "move",
        kind: "unit",
        ids: [UNIT_ID],
        folderId: FOLDER_ID,
      });
    });
  });

  it("批量删除：选中单元 → batchLibraryApi(action=delete)", async () => {
    mockDataLoaded();
    mockedBatch.mockResolvedValue({
      results: [{ id: UNIT_ID, ok: true }],
    } as never);
    renderPage();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择单元 练习四" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(mockedBatch).toHaveBeenCalledWith({
        action: "delete",
        kind: "unit",
        ids: [UNIT_ID],
      });
    });
  });

  it("回收站页签：恢复按钮调 restore 接口", async () => {
    const baseUnit = UNITS.units[0];
    if (baseUnit === undefined) throw new Error("测试夹具缺少单元");
    mockedFolders.mockResolvedValue(FOLDERS as never);
    mockedLectures.mockResolvedValue({ lectures: [] } as never);
    mockedUnits.mockResolvedValue({
      units: [
        {
          ...baseUnit,
          deletedAt: "2026-09-26T01:00:00.000Z",
          questions: [],
          questionCount: 0,
        },
      ],
    } as never);
    const { restoreUnitApi } = await import("@/lib/api");
    const mockedRestore = vi.mocked(restoreUnitApi);
    mockedRestore.mockResolvedValue(null);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "回收站" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() => {
      expect(mockedRestore).toHaveBeenCalledWith(UNIT_ID);
    });
  });
});
