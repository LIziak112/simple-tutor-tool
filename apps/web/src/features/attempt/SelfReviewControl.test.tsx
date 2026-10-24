import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttemptResultQuestion } from "@tutor/contract";
import { beforeEach, expect, it, vi } from "vitest";
import { saveSelfReviewApi } from "@/lib/api";
import { SelfReviewControl } from "./SelfReviewControl";

vi.mock("@/lib/api", () => ({ saveSelfReviewApi: vi.fn() }));
const question: AttemptResultQuestion = {
  questionId: "q1",
  snapshot: {
    id: "q1",
    type: "fill",
    difficulty: 1,
    knowledge: [],
    stemMd: "题面",
    hintCount: 0,
  },
  answer: { kind: "fill", values: ["2"] },
  answers: { kind: "fill", blanks: [["2"]] },
  solutionMd: "参考解答",
  autoCorrect: null,
  finalCorrect: null,
  teacherMark: null,
  teacherComment: null,
  hintsOpened: [],
  selfReview: {
    mark: null,
    revision: 0,
    reviewedAt: null,
    source: null,
    canReview: true,
    awaitingSelfReview: true,
  },
};
function mount(
  value = question,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <SelfReviewControl attemptId="a1" question={value} preserveAttemptView />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(saveSelfReviewApi).mockReset();
});

it("自评即时生效，失败后重试复用幂等标识；重挂仍显示本次判断", async () => {
  vi.mocked(saveSelfReviewApi).mockRejectedValueOnce(new Error("网络中断"));
  vi.mocked(saveSelfReviewApi).mockResolvedValue({
    finalCorrect: false,
    review: {
      mark: false,
      revision: 1,
      reviewedAt: "2026-10-24T03:00:00Z",
      source: "self",
      canReview: true,
      awaitingSelfReview: false,
    },
  });
  const client = new QueryClient();
  const view = mount(question, client);
  expect(screen.getByText("已完成，待自评")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "错了" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "错了" }));
  await screen.findByText("自评错误");
  expect(vi.mocked(saveSelfReviewApi).mock.calls[0]).toEqual(
    vi.mocked(saveSelfReviewApi).mock.calls[1],
  );
  expect(vi.mocked(saveSelfReviewApi).mock.calls[0]?.[2]).toMatchObject({
    mark: false,
    baseRevision: 0,
  });
  view.unmount();
  mount(question, client);
  await screen.findByText("自评错误");
});

it("无参考答案与教师已判定不显示自评按钮", () => {
  mount({
    ...question,
    answers: null,
    solutionMd: null,
    selfReview: {
      mark: null,
      revision: 0,
      reviewedAt: null,
      source: null,
      canReview: false,
      awaitingSelfReview: false,
    },
  });
  expect(
    screen.getByText("暂无参考答案，不提供自评，可由老师批改。"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "错了" })).toBeNull();
});

it("自评不触发进行中作答详情重取，避免末题后强制打开整卷结果", async () => {
  const client = new QueryClient();
  const fetch = vi.fn();
  client.setQueryData(["student", "attempt", "a1"], { status: "draft" });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  vi.mocked(saveSelfReviewApi).mockResolvedValue({
    finalCorrect: true,
    review: {
      mark: true,
      revision: 1,
      reviewedAt: "2026-10-24T03:00:00Z",
      source: "self",
      canReview: true,
      awaitingSelfReview: false,
    },
  });
  mount(question, client);
  fireEvent.click(screen.getByRole("button", { name: "对了" }));
  await screen.findByText("自评正确");
  await waitFor(() => expect(invalidate).toHaveBeenCalled());
  expect(
    client.getQueryState(["student", "attempt", "a1"])?.isInvalidated,
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
