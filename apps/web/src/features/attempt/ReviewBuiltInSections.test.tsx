import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AttemptContextData,
  AttemptResultData,
  AttemptResultQuestion,
} from "@tutor/contract";
import { expect, it, vi } from "vitest";
import { ReviewBuiltInSection } from "./ReviewBuiltInSections";

vi.mock("./SelfReviewSection", () => ({
  SelfReviewSection: () => <p>本人自评操作</p>,
}));
vi.mock("./RubricReviewSection", () => ({
  RubricReviewSection: () => <p>量表三方记录</p>,
}));
const question = {
  questionId: "q1",
  snapshot: {
    id: "q1",
    type: "response",
    difficulty: 2,
    knowledge: [],
    stemMd: "写作任务",
    hintCount: 0,
  },
  answer: { kind: "response", body: "本人文章" },
  answers: { kind: "final", answer: "参考要点" },
  solutionMd: null,
  autoCorrect: null,
  teacherMark: null,
  teacherComment: null,
  finalCorrect: null,
  answered: true,
  studentFlag: null,
  hintsOpened: [],
  gradingPolicy: "reference_self",
  materialIds: ["m1"],
  rubricReview: {
    rubric: { items: [{ id: "r1", title: "结构" }], levels: 4 },
    self: null,
    agent: null,
    final: null,
    pendingAgentTaskId: null,
  },
} as AttemptResultQuestion;
const data = {
  attempt: { id: "attempt" },
  answersReleased: true,
  units: [{ id: "u1", title: "长文样卷", questions: [question] }],
} as unknown as AttemptResultData;
it("长文作答对照保留题干、本人正文、参考与自评，未公布不显示参考和动作", () => {
  const view = render(
    <ReviewBuiltInSection
      kind="answer_comparison"
      data={data}
      context={undefined}
      active
    />,
  );
  expect(screen.getByText("本人文章")).toBeVisible();
  expect(screen.getByText("参考要点")).toBeVisible();
  expect(screen.getByText("写作任务")).toBeVisible();
  expect(screen.getByText("本人自评操作")).toBeVisible();
  view.rerender(
    <ReviewBuiltInSection
      kind="answer_comparison"
      data={{ ...data, answersReleased: false }}
      context={undefined}
      active
    />,
  );
  expect(screen.queryByText("参考要点")).toBeNull();
  expect(screen.queryByText("本人自评操作")).toBeNull();
});
it("材料并列关联题，量表在公布前不挂载，未知用时不显示零", () => {
  const context = {
    materials: [
      {
        id: "m1",
        title: "材料一",
        sourceVersion: 1,
        contentMd: "材料正文",
        anchors: [],
        slots: [],
        mediaPaths: [],
      },
    ],
    groups: [],
  } as unknown as AttemptContextData;
  const view = render(
    <ReviewBuiltInSection
      kind="material_reading"
      data={data}
      context={context}
      active
    />,
  );
  expect(screen.getByText("材料正文")).toBeVisible();
  expect(screen.getByText("本人文章")).toBeVisible();
  view.rerender(
    <ReviewBuiltInSection
      kind="rubric_matrix"
      data={data}
      context={context}
      active
    />,
  );
  expect(screen.getByText("量表三方记录")).toBeVisible();
  view.rerender(
    <ReviewBuiltInSection
      kind="rubric_matrix"
      data={{ ...data, answersReleased: false }}
      context={context}
      active
    />,
  );
  expect(screen.queryByText("量表三方记录")).toBeNull();
  view.rerender(
    <ReviewBuiltInSection
      kind="time_distribution"
      data={data}
      context={context}
      active
    />,
  );
  expect(screen.getByText("无可靠记录")).toBeVisible();
});

it("较长分区分页，切页复用已有题目事实", () => {
  const large = {
    ...data,
    units: [
      {
        id: "u1",
        title: "大卷",
        questions: Array.from({ length: 21 }, (_, i) => ({
          ...question,
          questionId: `q${i + 1}`,
        })),
      },
    ],
  };
  render(
    <ReviewBuiltInSection
      kind="time_distribution"
      data={large}
      context={undefined}
      active
    />,
  );
  expect(screen.getAllByText("无可靠记录")).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getAllByText("无可靠记录")).toHaveLength(1);
  expect(screen.getByText("第 21 题")).toBeVisible();
});
