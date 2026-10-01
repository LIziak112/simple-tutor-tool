import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  LibraryLectureList,
  LibraryUnitList,
  LibraryUsage,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_FOLDER_STORAGE_KEY } from "@/features/library/library-view-memory";
import {
  batchLibraryApi,
  deleteUnitApi,
  fetchLibraryFolders,
  fetchLibraryLectures,
  fetchLibraryUnits,
  fetchUnitUsageApi,
  renameLibraryFolderApi,
  reorderLibraryFoldersApi,
} from "@/lib/api";
import LibraryPage from "./LibraryPage";

/**
 * 资源库页面组件测试（T2A.2 验收项）：
 * - 删除确认弹层列出使用情况（课程名 + 作业名 + 作答数）；
 * - 批量移动（选目标文件夹后调 batchLibraryApi action=move）、批量删除、批量恢复；
 * - 页签 / 文件夹选中记忆（sessionStorage：离开再进入不丢状态，显式 ?tab= 优先）；
 * - 文件夹行改名与上移/下移兜底排序（单行布局 + ⋯ 菜单回归，含边界禁用）；
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
    renameLibraryFolderApi: vi.fn(),
    reorderLibraryFoldersApi: vi.fn(),
    deleteLibraryFolderApi: vi.fn(),
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

const LECTURES: LibraryLectureList = {
  lectures: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "第1讲 有理数",
      folderId: FOLDER_ID,
      updatedAt: "2026-09-26T00:00:00.000Z",
      deletedAt: null,
      courseCount: 0,
    },
  ],
};

function renderPage(initialEntry = "/t/library") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
  sessionStorage.clear();
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

  it("批量发布：选中单元 → 确认弹层说明快照语义 → batchLibraryApi(action=publish) + 成功提示", async () => {
    mockDataLoaded();
    mockedBatch.mockResolvedValue({
      results: [
        {
          id: UNIT_ID,
          ok: true,
          filename: "练习四-teacher-20260930-120000.md",
        },
      ],
    } as never);
    renderPage();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择单元 练习四" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "发布到共享…" }));
    // 确认弹层：快照语义说明（D16）
    expect(screen.getByText(/快照副本/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^确认发布/ }));
    await waitFor(() => {
      expect(mockedBatch).toHaveBeenCalledWith({
        action: "publish",
        kind: "unit",
        ids: [UNIT_ID],
      });
    });
    expect(
      await screen.findByText(/已发布 1 项到共享目录/),
    ).toBeInTheDocument();
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

  // ---------- 页签 / 文件夹选中记忆（离开再进入不丢状态） ----------

  it("页签记忆：切到讲义库后离开再进入，仍停在讲义库", async () => {
    mockDataLoaded();
    mockedLectures.mockResolvedValue(LECTURES as never);
    const first = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "讲义库" }));
    expect(screen.getByRole("tab", { name: "讲义库" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    first.unmount();

    // 无 ?tab= 重新进入：恢复上次页签，而非回落默认题库
    renderPage();
    expect(screen.getByRole("tab", { name: "讲义库" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("第1讲 有理数")).toBeInTheDocument();
  });

  it("显式 ?tab=recycle 直达回收站，记忆随之更新", async () => {
    mockDataLoaded();
    const first = renderPage("/t/library?tab=recycle");
    expect(screen.getByRole("tab", { name: "回收站" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    first.unmount();

    renderPage();
    expect(screen.getByRole("tab", { name: "回收站" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("切回题库后记忆同步：再进入仍是题库", async () => {
    mockDataLoaded();
    const first = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "讲义库" }));
    fireEvent.click(screen.getByRole("tab", { name: "题库" }));
    first.unmount();

    renderPage();
    expect(screen.getByRole("tab", { name: "题库" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("checkbox", { name: "选择单元 练习四" }),
    ).toBeInTheDocument();
  });

  it("文件夹选中记忆：选中文件夹后离开再进入，仍选中该文件夹", async () => {
    mockDataLoaded();
    const first = renderPage();
    // 名称 span 在选中按钮内：点击 span 冒泡即选中（按钮可访问名是名称+计数拼接，不便按名查询）
    fireEvent.click(await screen.findByText("有理数"));
    await waitFor(() => {
      expect(mockedUnits).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: FOLDER_ID }),
      );
    });
    first.unmount();

    renderPage();
    const nameText = await screen.findByText("有理数");
    expect(nameText.closest("button")).toHaveAttribute("aria-current", "true");
  });

  it("记忆的文件夹已不存在时，回落「全部」", async () => {
    mockDataLoaded();
    sessionStorage.setItem(
      LIBRARY_FOLDER_STORAGE_KEY,
      JSON.stringify("99999999-9999-4999-8999-999999999999"),
    );
    renderPage();
    // 文件夹列表加载后：失效记忆被清除，选中回落「全部」
    await waitFor(() => {
      expect(screen.getByText("全部").closest("button")).toHaveAttribute(
        "aria-current",
        "true",
      );
    });
  });

  // ---------- 文件夹行操作（⋯ 菜单回归：单行布局，操作收进更多菜单） ----------

  /** 打开指定文件夹行的「⋯」更多操作菜单（radix 触发器 pointerdown 即开） */
  async function openFolderMenu(folderName: string) {
    fireEvent.pointerDown(
      await screen.findByRole("button", {
        name: `文件夹「${folderName}」的更多操作`,
      }),
    );
  }

  it("文件夹行内改名：⋯ 菜单 → 重命名 → 输入新名保存 → renameLibraryFolderApi", async () => {
    mockDataLoaded();
    const mockedRename = vi.mocked(renameLibraryFolderApi);
    mockedRename.mockResolvedValue(FOLDERS.folders[0] as never);
    renderPage();
    await openFolderMenu("有理数");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "重命名文件夹 有理数" }),
    );
    fireEvent.change(await screen.findByLabelText("文件夹「有理数」的新名称"), {
      target: { value: "有理数运算" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存文件夹名" }));
    await waitFor(() => {
      expect(mockedRename).toHaveBeenCalledWith(FOLDER_ID, {
        name: "有理数运算",
      });
    });
  });

  it("双击文件夹名直接进入改名：输入新名保存 → renameLibraryFolderApi", async () => {
    mockDataLoaded();
    const mockedRename = vi.mocked(renameLibraryFolderApi);
    mockedRename.mockResolvedValue(FOLDERS.folders[0] as never);
    renderPage();
    const nameText = await screen.findByText("有理数");
    fireEvent.doubleClick(nameText);
    fireEvent.change(await screen.findByLabelText("文件夹「有理数」的新名称"), {
      target: { value: "有理数运算" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存文件夹名" }));
    await waitFor(() => {
      expect(mockedRename).toHaveBeenCalledWith(FOLDER_ID, {
        name: "有理数运算",
      });
    });
  });

  it("上移菜单项兜底排序：上移第二个文件夹 → reorderLibraryFoldersApi 收到新顺序", async () => {
    const SECOND_FOLDER_ID = "33333333-3333-4333-8333-333333333333";
    mockedFolders.mockResolvedValue({
      folders: [
        FOLDERS.folders[0],
        {
          id: SECOND_FOLDER_ID,
          name: "代数",
          order: 1,
          lectureCount: 0,
          unitCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    } as never);
    mockedLectures.mockResolvedValue({ lectures: [] } as never);
    mockedUnits.mockResolvedValue({ units: [] } as never);
    const mockedReorder = vi.mocked(reorderLibraryFoldersApi);
    mockedReorder.mockResolvedValue(null);
    renderPage();
    await openFolderMenu("代数");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "上移文件夹 代数" }),
    );
    await waitFor(() => {
      expect(mockedReorder).toHaveBeenCalledWith({
        ids: [SECOND_FOLDER_ID, FOLDER_ID],
      });
    });
  });

  it("菜单边界禁用：首个「上移」禁用、末个「下移」禁用，排序零调用", async () => {
    const SECOND_FOLDER_ID = "33333333-3333-4333-8333-333333333333";
    mockedFolders.mockResolvedValue({
      folders: [
        FOLDERS.folders[0],
        {
          id: SECOND_FOLDER_ID,
          name: "代数",
          order: 1,
          lectureCount: 0,
          unitCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    } as never);
    mockedLectures.mockResolvedValue({ lectures: [] } as never);
    mockedUnits.mockResolvedValue({ units: [] } as never);
    const mockedReorder = vi.mocked(reorderLibraryFoldersApi);
    mockedReorder.mockResolvedValue(null);
    renderPage();
    // 首个文件夹：上移禁用（radix 禁用项标 data-disabled）、下移可用
    await openFolderMenu("有理数");
    expect(
      await screen.findByRole("menuitem", { name: "上移文件夹 有理数" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: "下移文件夹 有理数" }),
    ).not.toHaveAttribute("data-disabled");
    // Esc 关闭首个菜单（菜单开着时 radix 会把菜单外元素 aria-hidden，须先收起）
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "上移文件夹 有理数" }),
      ).toBeNull();
    });
    // 打开末个文件夹菜单：下移禁用、上移可用
    await openFolderMenu("代数");
    expect(
      await screen.findByRole("menuitem", { name: "下移文件夹 代数" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: "上移文件夹 代数" }),
    ).not.toHaveAttribute("data-disabled");
    expect(mockedReorder).not.toHaveBeenCalled();
  });

  it("长文件夹名：完整名称在 DOM 中，名称按钮带 title 悬停全名", async () => {
    const longName = "七年级下册有理数混合运算专项训练";
    mockedFolders.mockResolvedValue({
      folders: [{ ...FOLDERS.folders[0], name: longName }],
    } as never);
    mockedLectures.mockResolvedValue({ lectures: [] } as never);
    mockedUnits.mockResolvedValue({ units: [] } as never);
    renderPage();
    // 名称 span 完整渲染（截断只是 CSS）；其所属按钮带 title 提供悬停全名
    const nameText = await screen.findByText(longName);
    expect(nameText.closest("button")).toHaveAttribute("title", longName);
  });
});
