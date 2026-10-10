import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LibraryUnitSummary, LibraryUsage } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnitDetailSheet } from "@/features/library/UnitDetailSheet";
import {
  downloadTeachingPack,
  fetchLectureUsageApi,
  publishUnitToSharedApi,
  updateUnitMetaApi,
} from "@/lib/api";

/**
 * 单元详情面板测试：T2B.7「发布到共享」（确认弹层说明快照语义）与
 * T7.8「导出教学包」（按钮直下 ZIP；失败展示服务端中文错误）。
 */

const apiMocks = vi.hoisted(() => ({
  publishUnitToSharedApi: vi.fn(),
  updateUnitMetaApi: vi.fn(),
  fetchLectureUsageApi: vi.fn(),
  downloadTeachingPack: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    publishUnitToSharedApi: apiMocks.publishUnitToSharedApi,
    updateUnitMetaApi: apiMocks.updateUnitMetaApi,
    fetchLectureUsageApi: apiMocks.fetchLectureUsageApi,
    downloadTeachingPack: apiMocks.downloadTeachingPack,
  };
});

vi.mocked(publishUnitToSharedApi);
vi.mocked(downloadTeachingPack);
vi.mocked(updateUnitMetaApi);
vi.mocked(fetchLectureUsageApi);

const UNIT: LibraryUnitSummary = {
  id: "练习四",
  title: "练习四",
  topic: null,
  folderId: null,
  lectureId: null,
  lectureTitle: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  deletedAt: null,
  questionCount: 8,
  typeDistribution: {},
  knowledge: [],
  courseCount: 0,
  assignmentCount: 0,
  questions: [],
};

const USAGE: LibraryUsage = {
  courses: [],
  assignments: [],
  attemptCount: 0,
};

function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UnitDetailSheet
        unit={UNIT}
        options={{ folders: [], lectures: [] }}
        usage={USAGE}
        usagePending={false}
        usageError={null}
        onDelete={() => undefined}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UnitDetailSheet 发布到共享（确认弹层说明快照语义）", () => {
  it("「发布到共享」→ 弹层说明快照副本 → 确认 → 展示实际文件名", async () => {
    apiMocks.publishUnitToSharedApi.mockResolvedValue({
      filename: "练习四-teacher-20260930-120000.md",
    });
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "发布到共享" }));
    // 确认弹层（D16）：说明发布的是快照副本
    expect(screen.getByText("发布单元到共享目录？")).toBeInTheDocument();
    expect(screen.getByText(/快照副本/)).toBeInTheDocument();
    expect(screen.getByText(/已发布文件不受影响/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    // 第二实参为 react-query 注入的上下文对象，只断言业务参数
    await waitFor(() =>
      expect(apiMocks.publishUnitToSharedApi).toHaveBeenCalledWith(
        "练习四",
        expect.anything(),
      ),
    );
    // 成功态展示实际写入文件名（含重名序号）
    expect(await screen.findByText("已发布到共享目录")).toBeInTheDocument();
    expect(
      screen.getByText(/练习四-teacher-20260930-120000\.md/),
    ).toBeInTheDocument();
  });

  it("发布失败：弹层内展示中文错误，不关弹层", async () => {
    apiMocks.publishUnitToSharedApi.mockRejectedValue(new Error("服务器繁忙"));
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "发布到共享" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    expect(await screen.findByText("服务器繁忙")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认发布" }),
    ).toBeInTheDocument();
  });
});

describe("UnitDetailSheet 导出教学包（T7.8）", () => {
  it("「导出教学包」→ 调 downloadTeachingPack(unit, id)", async () => {
    apiMocks.downloadTeachingPack.mockResolvedValue(undefined);
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "导出教学包" }));
    await waitFor(() =>
      expect(apiMocks.downloadTeachingPack).toHaveBeenCalledWith(
        "unit",
        "练习四",
      ),
    );
  });

  it("导出失败：面板展示服务端中文错误（如声明引用失效 422 的明细）", async () => {
    apiMocks.downloadTeachingPack.mockRejectedValue(
      new Error(
        "教学包导出前检查未通过（第 2 行：引用了未注册的指令），未生成包",
      ),
    );
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "导出教学包" }));
    expect(
      await screen.findByText(/教学包导出前检查未通过/),
    ).toBeInTheDocument();
  });
});
