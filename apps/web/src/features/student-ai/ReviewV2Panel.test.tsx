import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewV2Panel } from "./ReviewV2Panel";

const state = vi.hoisted(() => ({ studentId: "student-a" }));
const api = vi.hoisted(() => ({
  listReviewRuns: vi.fn(),
  previewReviewRun: vi.fn(),
  createReviewRun: vi.fn(),
  readReviewRun: vi.fn(),
  cancelReviewRun: vi.fn(),
}));
vi.mock("@/features/auth/student-auth", () => ({
  useStudentMe: () => ({ data: { id: state.studentId } }),
}));
vi.mock("./review-v2-api", () => api);
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.studentId = "student-a";
  api.listReviewRuns.mockResolvedValue([]);
  api.previewReviewRun.mockResolvedValue({
    previewVersion: "frozen-preview",
    questionCount: 2,
    partCount: 1,
  });
  api.createReviewRun.mockResolvedValue({
    id: "run-a",
    purpose: "测试",
    questionCount: 2,
    tasks: [],
  });
});
it("未知结果重试沿用同一请求与预览版本，不重复预览", async () => {
  api.createReviewRun.mockRejectedValueOnce(new Error("网络中断"));
  render(<ReviewV2Panel attemptId="attempt-a" released />);
  fireEvent.click(screen.getByRole("button", { name: "范围复盘" }));
  fireEvent.click(await screen.findByRole("button", { name: "创建范围复盘" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "重试同一份复盘" }),
  );
  await waitFor(() => expect(api.createReviewRun).toHaveBeenCalledTimes(2));
  expect(api.createReviewRun.mock.calls[0]?.[1]).toEqual(
    api.createReviewRun.mock.calls[1]?.[1],
  );
  expect(api.createReviewRun.mock.calls[0]?.[1]).toMatchObject({
    expectedPreviewVersion: "frozen-preview",
  });
  expect(api.previewReviewRun).toHaveBeenCalledTimes(1);
});
it("切账号后迟到预览不能借新账号创建复盘", async () => {
  let resolve: ((value: { previewVersion: string }) => void) | undefined;
  api.previewReviewRun.mockImplementation(
    () =>
      new Promise((value) => {
        resolve = value;
      }),
  );
  const view = render(<ReviewV2Panel attemptId="attempt-a" released />);
  fireEvent.click(screen.getByRole("button", { name: "范围复盘" }));
  fireEvent.click(await screen.findByRole("button", { name: "创建范围复盘" }));
  await waitFor(() => expect(api.previewReviewRun).toHaveBeenCalledOnce());
  state.studentId = "student-b";
  view.rerender(<ReviewV2Panel attemptId="attempt-a" released />);
  resolve?.({ previewVersion: "late-preview" });
  await waitFor(() =>
    expect(api.previewReviewRun.mock.calls[0]?.[2].aborted).toBe(true),
  );
  expect(api.createReviewRun).not.toHaveBeenCalled();
});
it("本批范围与长文profile来自真实入口，不能扩大为整卷", async () => {
  render(
    <ReviewV2Panel
      attemptId="attempt-a"
      released
      scope={{ kind: "settlement", seq: 2 }}
      profile="essay"
      label="本批复盘"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "本批复盘" }));
  fireEvent.click(await screen.findByRole("button", { name: "创建范围复盘" }));
  await waitFor(() => expect(api.createReviewRun).toHaveBeenCalledOnce());
  expect(api.createReviewRun.mock.calls[0]?.[1]).toMatchObject({
    scope: { kind: "settlement", seq: 2 },
    profile: "essay",
  });
});
