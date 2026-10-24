import { render, screen, within } from "@testing-library/react";
import type { AttemptResultQuestion } from "@tutor/contract";
import { expect, it } from "vitest";
import { ResultAnswerComparison } from "./ResultAnswerComparison";

const question: Pick<AttemptResultQuestion, "snapshot" | "answer" | "answers"> =
  {
    snapshot: {
      id: "fill",
      type: "fill",
      difficulty: 1,
      knowledge: [],
      stemMd: "计算 [[ ]]；[[ ]]。",
      hintCount: 0,
    },
    answer: { kind: "fill", values: ["\\frac{1}{2}"] },
    answers: { kind: "fill", blanks: [["\\frac{1}{2}"], ["8"]] },
  };

it("填空按空号对照，缺项明确未填，本人和参考公式都可读", () => {
  const { container } = render(
    <ResultAnswerComparison question={question} released />,
  );
  const own = screen.getByRole("list", { name: "你的填空答案" });
  expect(within(own).getAllByRole("listitem")).toHaveLength(2);
  expect(own).toHaveTextContent("第2空未填");
  expect(container.querySelectorAll(".katex")).toHaveLength(2);
  expect(screen.getByRole("list", { name: "参考填空答案" })).toHaveTextContent(
    "8",
  );
});

it("公布前不读取参考答案空数或内容，温和展示截止后公布提示", () => {
  render(
    <ResultAnswerComparison
      question={{
        ...question,
        answers: { kind: "fill", blanks: [["secret"], ["8"], ["secret"]] },
      }}
      released={false}
    />,
  );
  expect(screen.queryByRole("list", { name: "参考填空答案" })).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(
    screen.getByText("参考答案与详解将在截止后公布 🔒"),
  ).toBeInTheDocument();
});

// ---------- QM-13 细项 5：matching/ordering 逐项对照（TT-09b 通用文本占位随
// QM-13 登记真实视图后自动消失——§21.2-3 登记表成员判别口径，本节为转正断言） ----------

const matchingQuestion: Pick<
  AttemptResultQuestion,
  "snapshot" | "answer" | "answers"
> = {
  snapshot: {
    id: "match",
    type: "matching",
    difficulty: 1,
    knowledge: [],
    stemMd: "把城市与国家配对。",
    hintCount: 0,
    // 对照需要作答面结构（与公开投影同字段，resultQuestionOf 随结果快照下发）
    matchingOptions: {
      allowRepeat: false,
      options: [
        { id: "opt-1", text: "中国", distractor: false },
        { id: "opt-2", text: "日本", distractor: false },
      ],
    },
    matchingSlots: ["北京", "东京"],
  },
  answer: { kind: "matching", pairs: { 北京: "opt-1" } },
  answers: {
    kind: "matching",
    pairs: { 北京: "opt-1", 东京: "opt-2" },
  },
};

const orderingQuestion: Pick<
  AttemptResultQuestion,
  "snapshot" | "answer" | "answers"
> = {
  snapshot: {
    id: "order",
    type: "ordering",
    difficulty: 2,
    knowledge: [],
    stemMd: "按温差排序。",
    hintCount: 0,
    orderingItems: [
      {
        id: "it-1",
        text: "+4（周二）",
        fixedPosition: null,
        distractor: false,
      },
      {
        id: "it-2",
        text: "-2（周三）",
        fixedPosition: null,
        distractor: false,
      },
      { id: "it-3", text: "+3（周四）", fixedPosition: 2, distractor: false },
    ],
  },
  answer: { kind: "ordering", sequence: ["it-1", "it-2"] },
  answers: { kind: "ordering", sequence: ["it-2", "it-3", "it-1"] },
};

it("QM-13 matching 逐项对照：两栏按槽位序逐行（未选择如实），不再走通用文本占位", () => {
  const { container } = render(
    <ResultAnswerComparison question={matchingQuestion} released />,
  );
  expect(screen.getByText("你的答案：")).toBeInTheDocument();
  expect(screen.getByText("参考答案：")).toBeInTheDocument();
  expect(container.textContent).toContain("第 1 空：中国");
  expect(container.textContent).toContain("第 2 空：未选择");
  expect(container.textContent).toContain("第 2 空：日本");
  // 通用文本占位（裸 id 文本化）已消失
  expect(screen.queryByText("北京 = opt-1")).toBeNull();
  expect(screen.queryByText("东京 = opt-2；北京 = opt-1")).toBeNull();
});

it("QM-13 ordering 逐位对照：本人按序、参考按正确序（固定项标注），不再走通用文本占位", () => {
  const { container } = render(
    <ResultAnswerComparison question={orderingQuestion} released />,
  );
  expect(container.textContent).toContain("你的答案：");
  expect(container.textContent).toContain("参考答案：");
  expect(container.textContent).toContain("第 1 位：+4（周二）");
  expect(container.textContent).toContain("第 2 位：-2（周三）");
  // 参考列按参考序逐位（it-2 第 1 位、it-3 第 2 位固定标注）
  expect(container.textContent).toContain("第 1 位：-2（周三）");
  expect(container.textContent).toContain("（已固定）");
  expect(screen.queryByText("it-1 → it-2")).toBeNull();
});

it("QM-13 matching 未公布/无参考沿用三态（锁定提示/暂无参考答案），未作答显示未作答", () => {
  const { unmount } = render(
    <ResultAnswerComparison question={matchingQuestion} released={false} />,
  );
  expect(
    screen.getByText("参考答案与详解将在截止后公布 🔒"),
  ).toBeInTheDocument();
  unmount();

  render(
    <ResultAnswerComparison
      question={{ ...matchingQuestion, answers: null, answer: null }}
      released
    />,
  );
  expect(screen.getByText("暂无参考答案")).toBeInTheDocument();
  expect(screen.getByText("未作答")).toBeInTheDocument();
});
