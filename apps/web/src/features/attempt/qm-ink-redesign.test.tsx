import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AttemptQuestionPublic } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicQuestion,
  publicContentSignatureOf,
} from "@/features/annotation/question-base-image";
import {
  getScratchContextLabel,
  renderScratchContext,
} from "@/features/answering/scratch-context";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import { QuestionSurface } from "./QuestionSurface";

vi.mock("@/lib/api", () => ({
  fetchAttemptInkApi: vi.fn(async () => null),
  putAttemptInkApi: vi.fn(async () => ({
    questionId: "",
    inkId: "",
    strokeCount: 0,
    width: 0,
    height: 0,
    updatedAt: "",
  })),
  studentInkPngUrl: (attemptId: string, questionId: string) =>
    `/api/student/attempts/${attemptId}/ink/${questionId}.png`,
  openAttemptHintApi: vi.fn(async () => ({
    questionId: "",
    index: 0,
    hint: "",
    hintCount: 0,
    hintsUsed: 0,
    hintsRemaining: 0,
  })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeQuestion(
  overrides: Partial<AttemptQuestionPublic> & {
    id: string;
    type: AttemptQuestionPublic["type"];
    stemMd: string;
  },
): AttemptQuestionPublic {
  return {
    questionRevisionId: "rev-default",
    hintCount: 0,
    difficulty: 3,
    knowledge: ["test"],
    ...overrides,
  };
}

describe("新题型圈画与草稿手写重构（qm-ink-redesign）", () => {
  describe("1. response 题型题面解耦（圈画几何绝对稳定）", () => {
    const responseQuestion = makeQuestion({
      id: "q-resp-1",
      type: "response",
      stemMd: "请阐述牛顿第一定律在日常生活中的应用。",
      wordMin: 50,
      wordMax: 300,
    });

    it("QuestionSurface 在 answer 模式下只渲染公开题干和字数提示，不包含 textarea 作答框", () => {
      render(
        <QuestionSurface
          question={responseQuestion}
          mode="answer"
          answer={{ kind: "response", body: "已填写作答内容" }}
        />,
      );

      // 包含公开题干
      expect(
        screen.getByText("请阐述牛顿第一定律在日常生活中的应用。"),
      ).toBeInTheDocument();
      // 包含字数要求提示
      expect(screen.getByText("建议 50–300 字")).toBeInTheDocument();
      // 绝对不包含 textarea（避免被圈画覆盖层遮挡，且避免输入导致题面高度改变）
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("QuestionSurface 在 export 模式下题面结构与 answer 模式一致", () => {
      const { container: answerContainer } = render(
        <QuestionSurface question={responseQuestion} mode="answer" />,
      );
      const answerHtml = answerContainer.innerHTML;
      cleanup();

      const { container: exportContainer } = render(
        <QuestionSurface question={responseQuestion} mode="export" />,
      );
      const exportHtml = exportContainer.innerHTML;

      // export 模式下的插槽与 DOM 文本一致
      expect(answerHtml).toContain("请阐述牛顿第一定律在日常生活中的应用。");
      expect(exportHtml).toContain("请阐述牛顿第一定律在日常生活中的应用。");
      expect(exportHtml).toContain("建议 50–300 字");
      expect(exportContainer.querySelector("textarea")).toBeNull();
    });

    it("AttemptQuestionCard 正常模式下渲染 ResponseAnswerField 且输入时调用 onAnswer", () => {
      const queryClient = new QueryClient();
      const onAnswer = vi.fn();
      render(
        <QueryClientProvider client={queryClient}>
          <AttemptQuestionCard
            index={0}
            question={responseQuestion}
            attemptId="att-1"
            answer={undefined}
            onAnswer={onAnswer}
          />
        </QueryClientProvider>,
      );

      const textbox = screen.getByRole("textbox", { name: "正文" });
      expect(textbox).toBeInTheDocument();
      expect(textbox).not.toBeDisabled();

      fireEvent.change(textbox, { target: { value: "我的作答内容" } });
      expect(onAnswer).toHaveBeenCalledWith(
        { kind: "response", body: "我的作答内容" },
        true,
      );
    });

    it("AttemptQuestionCard 在 readOnly 模式下依然渲染 ResponseAnswerField 且处于 disabled 状态", () => {
      const queryClient = new QueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <AttemptQuestionCard
            index={0}
            question={responseQuestion}
            attemptId="att-1"
            readOnly={true}
            answer={{ kind: "response", body: "已提交的学生答案正文" }}
            onAnswer={vi.fn()}
          />
        </QueryClientProvider>,
      );

      const textbox = screen.getByRole("textbox", { name: "正文" });
      expect(textbox).toBeInTheDocument();
      expect(textbox).toBeDisabled();
      expect(textbox).toHaveValue("已提交的学生答案正文");
      expect(screen.getByText(/正文已写 10 字/)).toBeInTheDocument();
    });

    it("AttemptQuestionCard 在没有 attemptId 时依然渲染 ResponseAnswerField", () => {
      const queryClient = new QueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <AttemptQuestionCard
            index={0}
            question={responseQuestion}
            answer={undefined}
            onAnswer={vi.fn()}
          />
        </QueryClientProvider>,
      );

      expect(screen.getByRole("textbox", { name: "正文" })).toBeInTheDocument();
    });
  });

  describe("2. 全屏草稿与手写上下文（renderScratchContext & getScratchContextLabel）", () => {
    it("getScratchContextLabel 精确识别包含备选结构的题型", () => {
      expect(
        getScratchContextLabel(
          makeQuestion({ id: "q1", type: "judge", stemMd: "判断题" }),
        ),
      ).toBe("题干");
      expect(
        getScratchContextLabel(
          makeQuestion({ id: "q2", type: "fill", stemMd: "填空题" }),
        ),
      ).toBe("题干");
      expect(
        getScratchContextLabel(
          makeQuestion({ id: "q3", type: "response", stemMd: "论述题" }),
        ),
      ).toBe("题干");

      expect(
        getScratchContextLabel(
          makeQuestion({
            id: "q4",
            type: "choice",
            stemMd: "单选",
            options: ["A", "B"],
          }),
        ),
      ).toBe("题目（含选项）");
      expect(
        getScratchContextLabel(
          makeQuestion({
            id: "q5",
            type: "multi",
            stemMd: "多选",
            options: ["A", "B"],
          }),
        ),
      ).toBe("题目（含选项）");
      expect(
        getScratchContextLabel(
          makeQuestion({
            id: "q6",
            type: "matching",
            stemMd: "配对",
            matchingOptions: {
              allowRepeat: false,
              options: [{ id: "o1", text: "X" }],
            },
          }),
        ),
      ).toBe("题目（含选项）");
      expect(
        getScratchContextLabel(
          makeQuestion({
            id: "q7",
            type: "ordering",
            stemMd: "排序",
            orderingItems: [{ id: "i1", text: "Y", fixedPosition: null }],
          }),
        ),
      ).toBe("题目（含选项）");
    });

    it("matching 题型在全屏草稿时渲染槽位与选项池", () => {
      const matchingQuestion = makeQuestion({
        id: "q-match-1",
        type: "matching",
        stemMd: "将下列物理量与其单位匹配：",
        matchingSlots: [
          { id: "s1", ordinal: 1 },
          { id: "s2", ordinal: 2 },
        ],
        matchingOptions: {
          allowRepeat: false,
          options: [
            { id: "o1", text: "牛顿 (N)" },
            { id: "o2", text: "焦耳 (J)" },
          ],
        },
      });

      const scratch = renderScratchContext(matchingQuestion);
      expect(scratch).not.toBeNull();

      render(<div>{scratch}</div>);
      expect(screen.getByText("待匹配槽位：")).toBeInTheDocument();
      expect(screen.getByText("第 1 空")).toBeInTheDocument();
      expect(screen.getByText("第 2 空")).toBeInTheDocument();
      expect(screen.getByText("备选项池")).toBeInTheDocument();
      expect(screen.getByText("牛顿 (N)")).toBeInTheDocument();
      expect(screen.getByText("焦耳 (J)")).toBeInTheDocument();
    });

    it("ordering 题型在全屏草稿时渲染待排序项和固定位置提示", () => {
      const orderingQuestion = makeQuestion({
        id: "q-order-1",
        type: "ordering",
        stemMd: "按时间顺序排列事件：",
        orderingItems: [
          { id: "item-1", text: "第一幕", fixedPosition: null },
          { id: "item-2", text: "第二幕", fixedPosition: null },
          { id: "item-3", text: "尾声", fixedPosition: 3 },
        ],
      });

      const scratch = renderScratchContext(orderingQuestion);
      expect(scratch).not.toBeNull();

      render(<div>{scratch}</div>);
      expect(screen.getByText("待排序项列表")).toBeInTheDocument();
      expect(screen.getByText("第一幕")).toBeInTheDocument();
      expect(screen.getByText("第二幕")).toBeInTheDocument();
      expect(screen.getByText("尾声")).toBeInTheDocument();
      expect(screen.getByText("已固定在第 3 位")).toBeInTheDocument();
    });

    it("response 题型在全屏草稿时渲染统一字数要求提示", () => {
      const responseQuestion = makeQuestion({
        id: "q-resp-2",
        type: "response",
        stemMd: "论述题题干",
        wordMin: 100,
        wordMax: 500,
      });

      const scratch = renderScratchContext(responseQuestion);
      expect(scratch).not.toBeNull();

      render(<div>{scratch}</div>);
      expect(screen.getByText("作答要求：建议 100–500 字")).toBeInTheDocument();
    });

    it("renderScratchContext 使用 displayStemMd 剥离内嵌选项列表，避免全屏重复", () => {
      const choiceQuestion = makeQuestion({
        id: "q-choice-dup",
        type: "choice",
        stemMd: "这是一道单选题。\n\n- [x] 选项A\n- [ ] 选项B",
        options: ["选项A", "选项B"],
      });

      const scratch = renderScratchContext(choiceQuestion);
      const { container } = render(<div>{scratch}</div>);

      // 内嵌的 "- [x] 选项A" 被 displayStemMd 剥离，选项仅在 <ol> 中呈现一次
      const optionElements = container.querySelectorAll("li");
      expect(optionElements).toHaveLength(2);
      expect(screen.getByText("这是一道单选题。")).toBeInTheDocument();
    });
  });

  describe("3. 圈画底图公共指纹与防泄露机制扩展", () => {
    it("publicContentSignatureOf 提取新题型的完整结构特征", () => {
      const qMatch = makeQuestion({
        id: "q-1",
        type: "matching",
        stemMd: "配对题",
        matchingSlots: [{ id: "s1", ordinal: 1 }],
        matchingOptions: {
          allowRepeat: false,
          options: [{ id: "o1", text: "X" }],
        },
      });

      const sig1 = publicContentSignatureOf(qMatch);
      expect(sig1.matchingSlots).toEqual([{ id: "s1", ordinal: 1 }]);
      expect(sig1.matchingOptions).toEqual({
        allowRepeat: false,
        options: [{ id: "o1", text: "X" }],
      });

      const sig2 = publicContentSignatureOf({
        ...qMatch,
        matchingOptions: {
          allowRepeat: false,
          options: [{ id: "o1", text: "Y" }],
        },
      });
      expect(JSON.stringify(sig1)).not.toBe(JSON.stringify(sig2));
    });

    it("assertPublicQuestion 能够拦截 matchingOptions 与 orderingItems 中的泄露标记", () => {
      const leakedMatch = makeQuestion({
        id: "q-leak-1",
        type: "matching",
        stemMd: "合法题干",
        matchingOptions: {
          allowRepeat: false,
          options: [{ id: "o1", text: "包含答案标记 [[secret]] 泄露" }],
        },
      });

      expect(() => assertPublicQuestion(leakedMatch)).toThrow(
        "题面包含答案标记或教师内容，拒绝生成底图",
      );

      const leakedOrder = makeQuestion({
        id: "q-leak-2",
        type: "ordering",
        stemMd: "合法题干",
        orderingItems: [
          {
            id: "item-1",
            text: "包含答案标记 [[secret]] 泄露",
            fixedPosition: null,
          },
        ],
      });

      expect(() => assertPublicQuestion(leakedOrder)).toThrow(
        "题面包含答案标记或教师内容，拒绝生成底图",
      );
    });
  });
});
