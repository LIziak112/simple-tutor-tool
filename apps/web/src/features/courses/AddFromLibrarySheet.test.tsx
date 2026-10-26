import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LibraryLectureList } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLibraryFolders, fetchLibraryLectures } from "@/lib/api";
import { AddFromLibrarySheet } from "./AddFromLibrarySheet";

/**
 * 「从资源库添加」抽屉组件测试（2026-10 讲练一体新增覆盖）：
 * 讲义页签 kind=lesson 行显「讲练」徽标（教师知道加进课程的是讲练页）；
 * 纯讲义行无徽标。读取经 @/lib/api mock（hook 层零改动，后端行为由
 * routes/library.test.ts 覆盖）。
 * 2026-10-20：没有可见配套练习时不发送 withCompanionUnits（避免服务端
 * 静默展开讲练页嵌入单元）。
 */

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));

vi.mock("@/features/courses/course-queries", () => ({
  useAddCourseItems: () => ({
    mutate: mutateMock,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchLibraryFolders: vi.fn(),
    fetchLibraryLectures: vi.fn(),
    fetchLibraryUnits: vi.fn(async () => ({ units: [] })),
    fetchLectureUsageApi: vi.fn(),
    fetchUnitUsageApi: vi.fn(),
  };
});

const mockedFolders = vi.mocked(fetchLibraryFolders);
const mockedLectures = vi.mocked(fetchLibraryLectures);

const LECTURES: LibraryLectureList = {
  lectures: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "lecture",
      title: "第1讲 有理数",
      folderId: null,
      updatedAt: "2026-09-26T00:00:00.000Z",
      deletedAt: null,
      courseCount: 0,
    },
    {
      id: "8a8a8a8a-8a8a-48a8-88a8-8a8a8a8a8a8a",
      kind: "lesson",
      title: "讲练 有理数热身",
      folderId: null,
      updatedAt: "2026-09-27T00:00:00.000Z",
      deletedAt: null,
      courseCount: 0,
    },
  ],
};

function renderSheet(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddFromLibrarySheet
          courseId="11111111-1111-4111-8111-111111111111"
          existingKeys={new Set()}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedFolders.mockReset();
  mockedLectures.mockReset();
  mutateMock.mockReset();
  mockedFolders.mockResolvedValue({ folders: [] });
});

describe("AddFromLibrarySheet：无可见配套练习时不发送 withCompanionUnits（2026-10-20）", () => {
  it("只选讲练页时请求只有讲义条目，不带 withCompanionUnits", async () => {
    mockedLectures.mockResolvedValue(LECTURES);
    renderSheet();

    fireEvent.click(
      await screen.findByRole("checkbox", { name: /讲练 有理数热身/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /添加 1 项/ }));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]?.[0]).toEqual({
      items: [
        {
          kind: "lecture",
          refId: "8a8a8a8a-8a8a-48a8-88a8-8a8a8a8a8a8a",
        },
      ],
      visible: true,
      parentId: null,
    });
  });
});

describe("AddFromLibrarySheet：讲义「讲练」徽标（2026-10 讲练一体）", () => {
  it("kind=lesson 行显「讲练」徽标（与标题同行）；纯讲义行无徽标", async () => {
    mockedLectures.mockResolvedValue(LECTURES);
    renderSheet();

    await screen.findByText("讲练 有理数热身");
    // 徽标恰好一个（纯讲义「第1讲 有理数」行没有）
    expect(screen.getAllByText("讲练")).toHaveLength(1);
    expect(screen.getByText("第1讲 有理数")).toBeInTheDocument();
  });
});
