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

// ---------- QM-11 细项 2：matching/ordering 通用文本占位（逐项格式留 QM-13） ----------

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
  },
  answer: { kind: "matching", pairs: { 北京: "opt-1" } },
  answers: {
    kind: "matching",
    pairs: { 北京: "opt-1", 东京: "opt-2" },
  },
};

it("QM-11 matching 占位：两栏通用文本对照（本人 display 文本化 + 参考序列化），不崩溃不伪造逐项格式", () => {
  const { container } = render(
    <ResultAnswerComparison question={matchingQuestion} released />,
  );
  expect(screen.getByText("你的答案：")).toBeInTheDocument();
  expect(screen.getByText("参考答案：")).toBeInTheDocument();
  // 本人 display：slot = 裸选项 id（emptyPublicStructure 回落）
  expect(screen.getByText("北京 = opt-1")).toBeInTheDocument();
  // 参考：键排序确定性序列化（slot = option；「；」连接）
  expect(screen.getByText("东京 = opt-2；北京 = opt-1")).toBeInTheDocument();
  expect(
    screen.getByText("逐项对照将在配对/排序题型上线后提供。"),
  ).toBeInTheDocument();
  // 未启用 KaTeX（通用纯文本，无公式渲染负担）
  expect(container.querySelectorAll(".katex")).toHaveLength(0);
});

it("QM-11 matching 未公布/无参考沿用占位三态（锁定提示/暂无参考答案），未作答显示未作答", () => {
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
