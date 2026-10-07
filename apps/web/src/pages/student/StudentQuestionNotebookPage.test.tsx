import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { NotebookRound, StudentNotebookData } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStudentNotebookApi } from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentQuestionNotebookPage from "./StudentQuestionNotebookPage";

/**
 * /s/notebook/:questionId 题目笔记本页（T6R.15 E）组件测试：三态齐全
 * （加载/空/错误）、轮次导航（上一轮/下一轮 + 轮次列表）、每轮徽标/来源/
 * 提交时间/题目版本徽标、原稿区接线（NoteOriginalView 桩）、订正列表
 * （反思分栏 + NoteVersionView 桩 + 未封存「编辑中」）、补充稿列表
 * （徽标 + 说明文案）、轮次头部链接回结果页。
 * 原稿/版本查看面板以桩替换（行为各自见 NoteOriginalView.test /
 * NoteVersionView.test）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchStudentNotebookApi: vi.fn(),
  };
});

vi.mock("@/features/notes/NoteOriginalView", async () => {
  const { NoteOriginalTestStub } = await import(
    "@/features/notes/note-original-test-stub"
  );
  return { NoteOriginalView: NoteOriginalTestStub };
});

vi.mock("@/features/notes/NoteVersionView", () => ({
  NoteVersionView: (props: Record<string, unknown>) => (
    <div
      data-testid="note-version-stub"
      data-version={String(props.versionId ?? "")}
      data-title={String(props.title ?? "")}
      data-openlabel={String(props.openLabel ?? "")}
    />
  ),
}));

const notebookMock = vi.mocked(fetchStudentNotebookApi);

const QUESTION_ID = "p1-q8";

function round(
  overrides: Partial<NotebookRound> & Pick<NotebookRound, "roundOrdinal">,
): NotebookRound {
  return {
    attemptId: `att-round-${overrides.roundOrdinal}`,
    sourceType: "assignment",
    sourceLabel: `第 ${overrides.roundOrdinal} 轮来源`,
    submittedAt: "2026-10-06T02:30:00.000Z",
    questionVersion: null,
    evidence: null,
    corrections: [],
    supplements: [],
    ...overrides,
  };
}

function notebookOf(rounds: NotebookRound[]): StudentNotebookData {
  return { questionId: QUESTION_ID, rounds };
}

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/notebook/${QUESTION_ID}`,
    routePath: "/s/notebook/:questionId",
    element: <StudentQuestionNotebookPage />,
  });
}

beforeEach(() => {
  notebookMock.mockReset();
});

describe("StudentQuestionNotebookPage：三态", () => {
  it("加载中显示骨架（不白屏）", async () => {
    notebookMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByLabelText("正在加载题目笔记本")).toBeInTheDocument();
  });

  it("错误态：中文错误 + 重试", async () => {
    notebookMock.mockRejectedValue(new Error("网络断开"));
    renderPage();
    expect(await screen.findByText("笔记本加载失败")).toBeInTheDocument();
    expect(screen.getByText(/网络断开/)).toBeInTheDocument();
    notebookMock.mockResolvedValue(notebookOf([round({ roundOrdinal: 1 })]));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByText("第 1 次")).toBeInTheDocument();
    });
  });

  it("空态：无已交卷轮次的解释与下一步动作", async () => {
    notebookMock.mockResolvedValue(notebookOf([]));
    renderPage();
    expect(await screen.findByText("这道题还没有历史记录")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "返回首页" }),
    ).toHaveAttribute("href", "/s/home");
  });
});

describe("StudentQuestionNotebookPage：轮次导航与每轮内容", () => {
  const TWO_ROUNDS: NotebookRound[] = [
    round({ roundOrdinal: 1, sourceLabel: "周末加练", questionVersion: 2 }),
    round({
      roundOrdinal: 2,
      sourceType: "wrong",
      sourceLabel: "错题重练 · 第 3 次",
      questionVersion: null,
      submittedAt: "2026-10-07T05:00:00.000Z",
      corrections: [
        {
          noteId: "88888888-8888-4888-8888-888888888801",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "correction",
          revision: 2,
          currentVersionId: "33333333-3333-4333-8333-333333333321",
          serverSavedAt: "2026-10-07T05:30:00.000Z",
          sealedAt: "2026-10-07T06:00:00.000Z",
          stuckAt: "第二问不会代入",
          errorCause: null,
        },
        {
          noteId: "88888888-8888-4888-8888-888888888802",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "correction",
          revision: 1,
          currentVersionId: "33333333-3333-4333-8333-333333333322",
          serverSavedAt: "2026-10-07T07:00:00.000Z",
          sealedAt: null,
          stuckAt: null,
          errorCause: null,
        },
      ],
      supplements: [
        {
          noteId: "99999999-9999-4999-8999-999999999901",
          attemptId: "att-round-2",
          questionId: QUESTION_ID,
          questionRevisionId: "qrev-1",
          phase: "supplement",
          revision: 1,
          currentVersionId: "33333333-3333-4333-8333-333333333331",
          serverSavedAt: "2026-10-07T08:00:00.000Z",
        },
      ],
    }),
  ];

  it("默认显示最新一轮：徽标/来源/提交时间/题目版本徽标（null 不显示）/原稿区接线/查看这一轮链接", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    // 默认第 2 轮（最新）
    expect(await screen.findByText("第 2 次")).toBeInTheDocument();
    expect(screen.getByText("错题重练 · 第 3 次")).toBeInTheDocument();
    expect(screen.getByText(/交卷时间：2026年10月7日/)).toBeInTheDocument();
    // 题目版本徽标：null 不显示（第 2 轮 questionVersion=null）
    expect(screen.queryByText("题目 v3")).toBeNull();
    // 原稿区：NoteOriginalView 桩带该轮 attemptId 与轮次标注
    const original = document.querySelector(
      '[data-testid="note-original-stub"]',
    ) as HTMLElement | null;
    expect(original?.dataset.attempt).toBe("att-round-2");
    expect(original?.dataset.round).toBe("第 2 次");
    expect(screen.getByRole("link", { name: "查看这一轮" })).toHaveAttribute(
      "href",
      "/s/attempts/att-round-2",
    );
  });

  it("上一轮导航到第 1 轮：题目版本徽标 v2 显示、原稿区切换 attemptId", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findByText("第 2 次");
    fireEvent.click(screen.getByRole("button", { name: "上一轮" }));
    await waitFor(() => {
      expect(screen.getByText("题目 v2")).toBeInTheDocument();
    });
    expect(screen.getByText("周末加练")).toBeInTheDocument();
    const original = document.querySelector(
      '[data-testid="note-original-stub"]',
    ) as HTMLElement | null;
    expect(original?.dataset.attempt).toBe("att-round-1");
  });

  it("轮次边界：第一轮「上一轮」禁用、最后一轮「下一轮」禁用；轮次列表可跳转", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findByText("第 2 次");
    expect(screen.getByRole("button", { name: "下一轮" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上一轮" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上一轮" })).toBeDisabled();
    });
    // 轮次列表：点「第 2 次」徽标直接跳回
    fireEvent.click(screen.getByRole("button", { name: "第 2 次" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上一轮" })).toBeEnabled();
    });
  });

  it("订正列表：已封存行反思分栏 + 查看入口；未封存行「编辑中」", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findByText("第 2 次");
    expect(screen.getByText("第二问不会代入")).toBeInTheDocument();
    expect(screen.getAllByText("我卡在哪里：")).toHaveLength(1);
    expect(screen.getByText("编辑中")).toBeInTheDocument();
    const stubs = [
      ...document.querySelectorAll('[data-testid="note-version-stub"]'),
    ];
    expect(stubs).toHaveLength(2); // 已封存订正 + 未封存订正（revision≥1 可查看）
    expect(stubs[0]?.getAttribute("data-version")).toBe(
      "33333333-3333-4333-8333-333333333321",
    );
    expect(stubs[1]?.getAttribute("data-openlabel")).toBe("查看订正");
  });

  it("补充稿列表：说明文案 + 徽标 + 查看入口（标题「补充稿」）", async () => {
    notebookMock.mockResolvedValue(notebookOf(TWO_ROUNDS));
    renderPage();
    await screen.findByText("第 2 次");
    expect(
      screen.getByText(/交卷后找回的材料，不能证明交卷前已固定/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("补充稿").length).toBeGreaterThanOrEqual(1);
    const stub = document.querySelector('[data-testid="note-version-stub"][data-title="补充稿"]');
    expect(stub?.getAttribute("data-version")).toBe(
      "33333333-3333-4333-8333-333333333331",
    );
  });

  it("空分区：无订正/无补充稿的轮次显示解释文案（不误导为加载失败）", async () => {
    notebookMock.mockResolvedValue(
      notebookOf([round({ roundOrdinal: 1, sourceLabel: "周末加练" })]),
    );
    renderPage();
    await screen.findByText("第 1 次");
    expect(screen.getByText("这一轮没有订正。")).toBeInTheDocument();
    expect(screen.getByText("这一轮没有补充稿。")).toBeInTheDocument();
  });
});
