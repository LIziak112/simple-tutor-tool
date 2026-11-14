import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { learningContextStore as store } from "@/features/learning-context/learning-context-store";
import { MemoQuickCaptureButton } from "@/features/memos/MemoQuickCapture";
import { enqueueMemo } from "@/features/memos/memo-outbox";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@/test/render-with-portal";
import { ResultAiActions, type useResultAiCompanion } from "./ResultAiActions";

vi.mock("@/features/memos/memo-outbox", () => ({
  enqueueMemo: vi.fn(async () => "queued"),
  useMemoOutbox: () => [],
}));
vi.mock("@/features/student-ai/AiQueueButton", () => ({
  AiQueueTrigger: () => null,
  AiQueueSheet: () => null,
}));
vi.mock("@/features/student-ai/AiBatchReviewPanel", () => ({
  AiBatchReviewPanel: () => null,
}));
beforeEach(() => {
  store.bindPrincipal("alice");
  store.reset();
  vi.mocked(enqueueMemo).mockClear();
});
afterEach(() => {
  cleanup();
  store.reset();
});
it.each(["wide", "narrow"] as const)(
  "结果页%s整卷随笔无所有题来源元数据，保留当前焦点",
  async (size) => {
    const attemptId = crypto.randomUUID(),
      revision = crypto.randomUUID();
    const host = store.registerHost(
      attemptId,
      (id) => ({
        anchor: {
          kind: "question",
          attemptId,
          questionId: id,
          label: "第 2 题",
        },
        reference: {
          kind: "question",
          attemptId,
          questionId: id,
          surface: "result",
          expectedQuestionRevisionId: revision,
        },
        context: {
          schemaVersion: 1,
          content: {
            courseId: null,
            unitId: null,
            lectureId: null,
            sectionId: null,
            questionId: id,
            titles: { course: null, unit: null, lecture: null },
          },
          session: {
            attemptId,
            questionRevisionId: revision,
            questionNo: 2,
            questionCount: 2,
            settlementSeq: 1,
          },
          view: null,
          deviceId: null,
        },
      }),
      "graded",
    );
    const source = host.sourceOf("q2");
    if (!source) throw new Error("missing q2");
    store.explicit(host, source);
    const before = store.getSnapshot();
    // 求助/复盘面板已替身隔离；这里只供给整卷工具栏实际消费的控制端。
    const companion = {
      send: { attemptId },
      openTask: vi.fn(),
      openQuestion: vi.fn(),
    } as unknown as ReturnType<typeof useResultAiCompanion>;
    render(
      <ResultAiActions
        attemptId={attemptId}
        questions={[]}
        released
        companion={companion}
        onOpenAttemptReview={vi.fn()}
      />,
    );
    if (size === "wide")
      fireEvent.click(screen.getByRole("button", { name: "随手记" }));
    else {
      fireEvent.keyDown(screen.getByRole("button", { name: "更多操作" }), {
        key: "Enter",
        code: "Enter",
      });
      fireEvent.click(await screen.findByRole("menuitem", { name: "随手记" }));
      await screen.findByRole("dialog");
    }
    fireEvent.change(screen.getByLabelText("随笔内容"), {
      target: { value: "整卷记录" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "保存" })),
    );
    const sent = vi.mocked(enqueueMemo).mock.calls.at(-1)?.[0];
    expect(sent).toBeDefined();
    expect({
      anchor: sent?.anchor,
      context: sent?.context,
      reference: sent?.reference,
      view: sent?.sourceView,
      display: sent?.sourceDisplay,
    }).toEqual({
      anchor: { kind: "none" },
      context: undefined,
      reference: undefined,
      view: undefined,
      display: undefined,
    });
    expect(store.getSnapshot()).toBe(before);
    expect(companion.openQuestion).not.toHaveBeenCalled();
  },
);
it("讲义工具栏仍保存真实课程/讲义来源，不被整卷修复一概去锚", async () => {
  const lectureId = "actual-lecture",
    courseId = crypto.randomUUID();
  const h = store.registerHost("lecture:actual", () => ({
    anchor: { kind: "lecture", lectureId, sectionId: null, label: "讲义" },
    reference: { kind: "lecture", lectureId, courseId, sectionId: null },
    context: {
      schemaVersion: 1,
      content: {
        courseId,
        unitId: null,
        lectureId,
        sectionId: null,
        questionId: null,
        titles: { course: "B课", unit: null, lecture: "讲义" },
      },
      session: null,
      view: null,
      deviceId: null,
    },
  }));
  const source = h.sourceOf(lectureId);
  if (!source) throw new Error("missing lecture");
  store.explicit(h, source);
  render(<MemoQuickCaptureButton />);
  fireEvent.click(screen.getByRole("button", { name: "随手记" }));
  fireEvent.change(screen.getByLabelText("随笔内容"), {
    target: { value: "讲义记录" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  const sent = vi.mocked(enqueueMemo).mock.calls.at(-1)?.[0];
  expect(sent?.anchor).toMatchObject({ kind: "lecture", lectureId });
  expect(sent?.reference).toEqual({
    kind: "lecture",
    lectureId,
    courseId,
    sectionId: null,
  });
  expect(sent?.context).toMatchObject({
    content: { courseId, lectureId, questionId: null },
    session: null,
  });
});
