import { fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  AttemptDraftData,
  AttemptResultData,
  AttemptStartData,
  InkDoc,
  StudentAnswer,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAttemptApi,
  putAttemptInkApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  submitAttemptApi,
} from "@/lib/api";
import { renderWithStudentRoutes } from "@/test/student-routes";
import StudentAssignmentAttemptPage from "./StudentAssignmentAttemptPage";

/**
 * 答题页整页流程测试（T2.6，API 层 mock）：
 * - 进入自动 POST attempt → 草稿视图渲染题卡与吸底进度条；
 * - 作答触发草稿保存（判断题立即保存）；
 * - 交卷确认弹层显示未答数量 → 确认后 submit → 详情失效重取 → 切结果视图；
 * - attempt 已交卷时进入直接渲染结果视图（不开新卷）。
 * T2.8 追加：交卷 flush——确认交卷先把每道手写题最新笔迹 PUT 上传（调用顺序
 * 先于 submit）；任一失败阻止交卷并给出可指导提示，恢复后重试成功。
 * 引擎（InkPad）mock 为「模拟书写一笔」按钮，控制笔迹变化时机。
 */

// InkPad mock：暴露触发 onDocChange 的按钮 + 填充可 exportPng 的引擎 stub
vi.mock("@/features/ink/InkPad", () => ({
  InkPad: (props: {
    engine?: string;
    onDocChange?: ((doc: InkDoc) => void) | undefined;
    engineRef?: { current: unknown };
  }) => {
    if (props.engineRef && props.engineRef.current === null) {
      props.engineRef.current = {
        getData: () => {
          throw new Error("测试未使用");
        },
        exportPng: () =>
          Promise.resolve(
            new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
          ),
      };
    }
    return (
      <div data-slot="ink-pad" data-engine={props.engine ?? "atrament"}>
        <button
          type="button"
          data-testid={`ink-emit-${props.engine ?? "atrament"}`}
          onClick={() =>
            props.onDocChange?.({
              engine: "atrament",
              version: 1,
              data: {
                width: 1000,
                strokes: [
                  {
                    tool: "pen",
                    color: "#000",
                    weight: 4,
                    points: [{ x: 1, y: 1, p: 0.5, t: 0 }],
                  },
                ],
              },
              updatedAt: 2,
            })
          }
        >
          模拟书写一笔
        </button>
      </div>
    );
  },
}));

// gzip mock：jsdom 的 Blob 流与 node 全局 CompressionStream 组合不可靠，
// 返回原始字节（服务端对无 gzip 魔数的载荷按原始 JSON 兼容解析）
vi.mock("@/features/ink/gzip", () => ({
  gzipOrRaw: async (text: string) => new TextEncoder().encode(text),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startAttemptApi: vi.fn(),
    fetchAttemptApi: vi.fn(),
    saveAttemptAnswerApi: vi.fn(),
    submitAttemptApi: vi.fn(),
    // T2.8：笔迹取回（默认无历史笔迹）与上传（成功回执）
    fetchAttemptInkApi: vi.fn(async () => null),
    putAttemptInkApi: vi.fn(async () => ({
      questionId: "q-ink",
      inkId: "77777777-7777-4777-8777-777777777777",
      strokeCount: 1,
      width: 100,
      height: 50,
      updatedAt: "2026-09-27T00:00:00.000Z",
    })),
  };
});

const mockedStart = vi.mocked(startAttemptApi);
const mockedFetch = vi.mocked(fetchAttemptApi);
const mockedSave = vi.mocked(saveAttemptAnswerApi);
const mockedSubmit = vi.mocked(submitAttemptApi);
const mockedPutInk = vi.mocked(putAttemptInkApi);

const ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

const START_DRAFT: AttemptStartData = {
  id: ATTEMPT_ID,
  assignmentId: ASSIGNMENT_ID,
  unitId: "练习四",
  status: "draft",
  startedAt: "2026-09-27T02:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};

const DRAFT_DATA: AttemptDraftData = {
  attempt: START_DRAFT,
  title: "周末加练",
  dueAt: "2026-10-01T12:00:00.000Z",
  questions: [
    {
      id: "练习四-1",
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
      stemMd: "$0$ 既不是正数，也不是负数。[[]]",
      hintCount: 0,
    },
    {
      id: "练习四-4",
      type: "fill",
      difficulty: 2,
      knowledge: ["有理数加法"],
      stemMd: "计算：$(-3)+7=$ [[]]。",
      hintCount: 1,
    },
  ],
  drafts: {},
};

const RESULT_DATA: AttemptResultData = {
  attempt: {
    ...START_DRAFT,
    status: "submitted",
    submittedAt: "2026-09-27T02:30:00.000Z",
    scoreAuto: 100,
  },
  title: "周末加练",
  dueAt: "2026-10-01T12:00:00.000Z",
  summary: {
    total: 2,
    answered: 2,
    correct: 2,
    wrong: 0,
    pending: 0,
    unanswered: 0,
    autoGradable: 2,
  },
  questions: [
    {
      questionId: "练习四-1",
      snapshot: {
        id: "练习四-1",
        type: "judge",
        difficulty: 1,
        knowledge: ["有理数的概念"],
        stemMd: "$0$ 既不是正数，也不是负数。[[正确]]",
        hintCount: 0,
      },
      answers: { kind: "judge", value: true },
      solutionMd: null,
      answer: { kind: "judge", value: true },
      autoCorrect: true,
    },
    {
      questionId: "练习四-4",
      snapshot: {
        id: "练习四-4",
        type: "fill",
        difficulty: 2,
        knowledge: ["有理数加法"],
        stemMd: "计算：$(-3)+7=$ [[4]]。",
        hintCount: 1,
      },
      answers: { kind: "fill", blanks: [["4"]] },
      solutionMd: null,
      answer: { kind: "fill", values: ["4"] },
      autoCorrect: true,
    },
  ],
};

function renderPage() {
  return renderWithStudentRoutes({
    initialPath: `/s/assignments/${ASSIGNMENT_ID}`,
    routePath: "/s/assignments/:id",
    element: <StudentAssignmentAttemptPage />,
  });
}

beforeEach(() => {
  mockedStart.mockReset();
  mockedFetch.mockReset();
  mockedSave.mockReset();
  mockedSubmit.mockReset();
  mockedPutInk.mockReset();
  mockedPutInk.mockResolvedValue({
    questionId: "q-ink",
    inkId: "77777777-7777-4777-8777-777777777777",
    strokeCount: 1,
    width: 100,
    height: 50,
    updatedAt: "2026-09-27T00:00:00.000Z",
  });
});

describe("StudentAssignmentAttemptPage：草稿作答流程", () => {
  it("进入自动创建 attempt 并渲染题卡、进度条与截止时间", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    renderPage();

    expect(await screen.findByText("周末加练")).toBeInTheDocument();
    expect(mockedStart).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(screen.getByText("第 1 题")).toBeInTheDocument();
    expect(screen.getByText("第 2 题")).toBeInTheDocument();
    // 进度条文本含 <b> 强调，用整页文本断言
    expect(document.body.textContent).toContain("已答 0 / 2 题");
    expect(screen.getByText("10月1日 20:00 截止")).toBeInTheDocument();
  });

  it("作答即保存：点判断题「对」立即 PUT 草稿，进度条更新", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(ATTEMPT_ID, "练习四-1", {
        kind: "judge",
        value: true,
      } satisfies StudentAnswer);
    });
    expect(document.body.textContent).toContain("已答 1 / 2 题");
  });

  it("交卷确认显示未答数量；确认后 submit 并切结果视图", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    // 第一次取详情=草稿，交卷失效后重取=结果
    mockedFetch
      .mockResolvedValueOnce(DRAFT_DATA)
      .mockResolvedValue(RESULT_DATA);
    mockedSave.mockResolvedValue({ questionId: "练习四-1", changeCount: 1 });
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第 1 题");
    fireEvent.click(screen.getByRole("radio", { name: /对/ }));
    await waitFor(() => expect(mockedSave).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "交卷" }));
    expect(
      await screen.findByText("还有 1 题没有作答，交卷后不能再修改答案。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认交卷" }));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledWith(ATTEMPT_ID));
    // 详情已失效重取 → 结果视图
    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "交卷" })).toBeNull();
  });

  it("attempt 创建失败显示错误态与重试", async () => {
    mockedStart.mockRejectedValue(new Error("未被指派此作业，无权作答"));
    renderPage();

    expect(await screen.findByText("打不开这份作业")).toBeInTheDocument();
    expect(screen.getByText("未被指派此作业，无权作答")).toBeInTheDocument();
    // 重试重新发起
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch.mockResolvedValue(DRAFT_DATA);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("周末加练");
  });
});

describe("StudentAssignmentAttemptPage：已交卷直接结果视图", () => {
  it("startAttempt 返回 submitted 时不开新卷，直接渲染结果", async () => {
    mockedStart.mockResolvedValue(RESULT_DATA.attempt);
    mockedFetch.mockResolvedValue(RESULT_DATA);
    renderPage();

    expect(await screen.findByText(/批改结果/)).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(ATTEMPT_ID);
    // 答题控件不出现
    expect(screen.queryByRole("radio", { name: /对/ })).toBeNull();
  });
});

// ---------- T2.8：交卷 flush（笔迹上传先于 submit） ----------

/** 两道手写题的草稿视图 */
const HANDWRITTEN_DRAFT: AttemptDraftData = {
  attempt: START_DRAFT,
  title: "手写练习",
  dueAt: null,
  questions: [
    {
      id: "q-ink-1",
      type: "solve",
      difficulty: 3,
      knowledge: ["计算"],
      stemMd: "第一道手写题",
      hintCount: 0,
    },
    {
      id: "q-ink-2",
      type: "apply",
      difficulty: 3,
      knowledge: ["应用"],
      stemMd: "第二道手写题",
      hintCount: 0,
    },
  ],
  drafts: {},
};

/** 展开下一道未展开的手写题并「书写一笔」（展开后按钮变「收起」，故每次取第一个） */
async function writeOnNextHandwritten(): Promise<void> {
  const toggles = screen.getAllByRole("button", { name: /展开手写区/ });
  fireEvent.click(toggles[0] as HTMLElement);
  const emits = await screen.findAllByTestId("ink-emit-atrament");
  fireEvent.click(emits[emits.length - 1] as HTMLElement);
}

/** 点交卷并确认 */
async function clickSubmitAndConfirm(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "交卷" }));
  const confirm = await screen.findByRole("button", { name: "确认交卷" });
  fireEvent.click(confirm);
}

describe("StudentAssignmentAttemptPage：交卷 flush", () => {
  it("两道手写题都写过 → 逐题 PUT 全部完成后才调 submit（调用顺序）", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await writeOnNextHandwritten();
    await writeOnNextHandwritten();
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    // 顺序：两次 PUT 的调用序号都早于 submit（任务验收口径）
    const submitOrder = mockedSubmit.mock.invocationCallOrder[0] ?? 0;
    for (const order of mockedPutInk.mock.invocationCallOrder) {
      expect(order).toBeLessThan(submitOrder);
    }
  });

  it("没写过笔迹的手写题不阻塞交卷（flush no-op）", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    expect(mockedPutInk).not.toHaveBeenCalled();
  });

  it("笔迹上传失败：submit 被阻止 + 底栏可指导提示；恢复后重新交卷成功", async () => {
    mockedStart.mockResolvedValue(START_DRAFT);
    mockedFetch
      .mockResolvedValueOnce(HANDWRITTEN_DRAFT)
      .mockResolvedValue(RESULT_DATA);
    mockedSubmit.mockResolvedValue(RESULT_DATA);
    renderPage();

    await screen.findByText("第一道手写题");
    await writeOnNextHandwritten();
    mockedPutInk.mockRejectedValueOnce(new Error("network down"));
    await clickSubmitAndConfirm();

    await waitFor(() => expect(mockedPutInk).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByText(/有题目的笔迹还没上传成功，交卷被暂时阻止/),
      ).toBeVisible(),
    );
    expect(mockedSubmit).not.toHaveBeenCalled();

    // 网络恢复：重新交卷 → flush 重试成功 → submit 才发生
    await clickSubmitAndConfirm();
    await waitFor(() => expect(mockedSubmit).toHaveBeenCalledTimes(1));
    expect(mockedPutInk).toHaveBeenCalledTimes(2);
  });
});
