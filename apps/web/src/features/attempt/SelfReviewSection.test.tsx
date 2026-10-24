import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AttemptResultQuestion, SelfReviewData } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, saveSelfReviewApi } from "@/lib/api";
import { SelfReviewSection } from "./SelfReviewSection";

/**
 * 学生对照自评交互件（QM-11）：reference_self 行公布后的「对了/错了/暂不
 * 判断」动作与三态状态（已完成待自评 / 自评正确错误 / 教师判定优先）；
 * CAS 409 _current 采纳、失败保留现场可重试（同意图复用 mutationId）、
 * 键盘可达（原生按钮）与屏幕阅读器状态（role=status/alert）。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    saveSelfReviewApi: vi.fn(),
  };
});
const mockedSave = vi.mocked(saveSelfReviewApi);

const ATTEMPT_ID = "att-1";

const questionOf = (
  overrides: Partial<AttemptResultQuestion> = {},
): AttemptResultQuestion =>
  ({
    questionId: "q1",
    snapshot: {
      id: "q1",
      type: "fill",
      difficulty: 1,
      knowledge: ["填空"],
      stemMd: "计算：[[1]]",
      hintCount: 0,
    },
    answers: { kind: "fill", blanks: [["1"]] },
    solutionMd: null,
    answer: { kind: "fill", values: ["1"] },
    autoCorrect: null,
    teacherMark: null,
    teacherComment: null,
    finalCorrect: null,
    gradingPolicy: "reference_self",
    selfReview: { record: null, revision: 0 },
    hintsOpened: [],
    ...overrides,
  }) as AttemptResultQuestion;

const okData = (verdict: "correct" | "wrong" | null, revision: number) =>
  ({
    selfReview:
      verdict === null
        ? null
        : { verdict, at: "2026-10-24T00:00:00.000Z", revision },
    effective:
      verdict === null
        ? null
        : { source: "self", value: verdict === "correct" },
    summary: {
      total: 1,
      answered: 1,
      correct: 0,
      wrong: 0,
      pending: 1,
      unanswered: 0,
      autoGradable: 0,
      scoreFinal: null,
      pendingCount: 1,
    },
  }) as SelfReviewData;

function renderSection(question: AttemptResultQuestion) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <SelfReviewSection attemptId={ATTEMPT_ID} question={question} />
    </QueryClientProvider>,
  );
  return { invalidateSpy, unmount: view.unmount };
}

beforeEach(() => {
  mockedSave.mockReset();
});

it("待自评：状态「已完成，待自评」+ 三动作；不自动替学生选（无按钮高亮/aria-pressed）", () => {
  renderSection(questionOf());
  const area = screen.getByRole("region", { name: "本题自评" });
  expect(screen.getByRole("status").textContent).toContain("已完成，待自评");
  expect(within(area).getByRole("button", { name: "对了" }));
  expect(within(area).getByRole("button", { name: "错了" }));
  // 未自评时「暂不判断」无可清除对象：禁用
  expect(within(area).getByRole("button", { name: "暂不判断" })).toBeDisabled();
  expect(
    within(area)
      .getByRole("button", { name: "对了" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

it("点「对了」：POST correct+baseRevision=0+uuid → 状态「自评正确」，失效本题与聚合缓存", async () => {
  const { invalidateSpy: spy } = renderSection(questionOf());
  mockedSave.mockResolvedValueOnce(okData("correct", 1));
  fireEvent.click(screen.getByRole("button", { name: "对了" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("自评正确"),
  );
  expect(mockedSave).toHaveBeenCalledTimes(1);
  const [attemptId, questionId, request] = mockedSave.mock.calls[0]!;
  expect(attemptId).toBe(ATTEMPT_ID);
  expect(questionId).toBe("q1");
  expect(request.verdict).toBe("correct");
  expect(request.baseRevision).toBe(0);
  expect(request.mutationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  // 成功后刷新本题与聚合缓存（attempt 前缀 + 讲练/记录/错题/教师聚合）
  const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
  expect(keys.some((key) => key.includes('"attempt"'))).toBe(true);
  expect(keys.some((key) => key.includes('"lesson"'))).toBe(true);
  expect(keys.some((key) => key.includes('"records"'))).toBe(true);
  expect(keys.some((key) => key.includes('"wrong-questions"'))).toBe(true);
});

it("修正与撤回：已评 correct 后点「错了」用 baseRevision=1；「暂不判断」清除回到待自评", async () => {
  renderSection(
    questionOf({
      selfReview: {
        record: {
          verdict: "correct",
          at: "2026-10-24T00:00:00.000Z",
          revision: 1,
        },
        revision: 1,
      },
    }),
  );
  expect(screen.getByRole("status").textContent).toContain("自评正确");
  expect(
    screen.getByRole("button", { name: "对了" }).getAttribute("aria-pressed"),
  ).toBe("true");
  mockedSave.mockResolvedValueOnce(okData("wrong", 2));
  fireEvent.click(screen.getByRole("button", { name: "错了" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("自评错误"),
  );
  expect(mockedSave.mock.calls[0]![2].baseRevision).toBe(1);

  mockedSave.mockResolvedValueOnce(okData(null, 3));
  fireEvent.click(screen.getByRole("button", { name: "暂不判断" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("已完成，待自评"),
  );
  expect(mockedSave.mock.calls[1]![2].verdict).toBe("undecided");
  expect(mockedSave.mock.calls[1]![2].baseRevision).toBe(2);
});

it("CAS 409 REVISION_CONFLICT：呈现冲突提示并采纳 _current 作为新基线（再评用 revision=2）", async () => {
  renderSection(
    questionOf({
      selfReview: {
        record: {
          verdict: "correct",
          at: "2026-10-24T00:00:00.000Z",
          revision: 1,
        },
        revision: 1,
      },
    }),
  );
  mockedSave.mockRejectedValueOnce(
    new ApiError(
      "SELF_REVIEW_REVISION_CONFLICT",
      "这道题的自评已在其他设备更新，请刷新后查看最新自评再试",
      409,
      { _current: { selfReview: null, revision: 2 } },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "错了" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("其他设备"),
  );
  // 冲突后：本机投影仍显示旧自评，但新基线已是 _current.revision=2
  mockedSave.mockResolvedValueOnce(okData("wrong", 3));
  fireEvent.click(screen.getByRole("button", { name: "错了" }));
  await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(2));
  expect(mockedSave.mock.calls[1]![2].baseRevision).toBe(2);
});

it("失败保留现场可重试：同一意图复用同一 mutationId，换意图换新键", async () => {
  renderSection(questionOf());
  mockedSave.mockRejectedValueOnce(
    new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "对了" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  // 现场保留：仍待自评、按钮可点
  expect(screen.getByRole("status").textContent).toContain("已完成，待自评");
  mockedSave.mockResolvedValueOnce(okData("correct", 1));
  fireEvent.click(screen.getByRole("button", { name: "对了" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("自评正确"),
  );
  const [first, second] = mockedSave.mock.calls.map((call) => call[2]);
  expect(second?.mutationId).toBe(first?.mutationId);
});

it("教师已判：整块不渲染（教师判定优先，不可被客户端覆盖）；manual_only 行提示不假装可自动判断", () => {
  const { unmount } = renderSection(
    questionOf({ teacherMark: "correct", finalCorrect: true }),
  );
  expect(screen.queryByRole("region", { name: "本题自评" })).toBeNull();
  unmount();

  renderSection(questionOf({ gradingPolicy: "manual_only", selfReview: null }));
  expect(screen.getByRole("status").textContent).toContain("暂无参考答案");
  expect(screen.queryByRole("button", { name: "对了" })).toBeNull();
});

it("旧行（gradingPolicy=null/缺省）与 auto 行不渲染：历史不开放自评、客观题自动判定走既有徽章", () => {
  const { unmount } = renderSection(
    questionOf({ gradingPolicy: null, selfReview: null }),
  );
  expect(screen.queryByRole("region", { name: "本题自评" })).toBeNull();
  unmount();

  renderSection(questionOf({ gradingPolicy: "auto" }));
  expect(screen.queryByRole("region", { name: "本题自评" })).toBeNull();
});

it("教师竞争 409 SELF_REVIEW_TEACHER_MARKED：提示且动作入口收起（显示以教师判定为准）", async () => {
  renderSection(
    questionOf({
      selfReview: {
        record: {
          verdict: "wrong",
          at: "2026-10-24T00:00:00.000Z",
          revision: 1,
        },
        revision: 1,
      },
    }),
  );
  mockedSave.mockRejectedValueOnce(
    new ApiError(
      "SELF_REVIEW_TEACHER_MARKED",
      "老师已判定这道题，无需自评",
      409,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "对了" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("老师已判定"),
  );
  expect(screen.queryByRole("button", { name: "对了" })).toBeNull();
});
