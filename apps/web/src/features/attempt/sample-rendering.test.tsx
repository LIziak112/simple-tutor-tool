import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import {
  type Question,
  type QuestionPublic,
  questionPublicSchema,
} from "@tutor/contract";
import { parseDocument, stemMdLeaksAnswers, studentStemMd } from "@tutor/md-dsl";
import { describe, expect, it, vi } from "vitest";
import {
  fullSampleBlocks,
  sampleFilesOfRepo,
} from "../../../../../test-support/dsl-samples.ts";
import { AttemptQuestionCard } from "./AttemptQuestionCard";

/**
 * T7.9 全部练习/混合样例题目的真实题卡渲染回归：
 * 自动发现 samples/v2 全部 .md + 完整样例三个 markdown 块 → parseDocument →
 * 按公共契约构造 QuestionPublic（stemMd 经 studentStemMd 学生端唯一投影）→
 * jsdom 挂载 AttemptQuestionCard，断言题面文本、公式（KaTeX）、填空空位、
 * 选项控件与手写题最终答案等必要语义；不做全文 HTML 快照。
 *
 * 题面测试不启动笔迹上传/网络（@/lib/api 全量 mock，与题卡测试同款工厂）；
 * 手写题笔迹全链由 HandwrittenControls / use-ink-upload 测试与 E2E 覆盖。
 */

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

/** 手写三题型（与题卡内 HANDWRITTEN_TYPES 同集合；渲染最终答案控件需 attemptId） */
const HANDWRITTEN_TYPES: ReadonlySet<Question["type"]> = new Set([
  "solve",
  "apply",
  "find-error",
]);

/** 全语料题目：samples/v2 自动发现的练习/混合文档 + 完整样例练习/混合块 */
function collectSampleQuestions(): Array<{
  source: string;
  question: Question;
}> {
  const docs = [
    ...sampleFilesOfRepo().map((file) => ({
      name: `samples/v2/${file.name}`,
      markdown: file.markdown,
    })),
    ...fullSampleBlocks(),
  ];
  const out: Array<{ source: string; question: Question }> = [];
  for (const doc of docs) {
    for (const unit of parseDocument(doc.markdown).units) {
      for (const question of unit.questions) {
        out.push({ source: `${doc.name}#${question.id}`, question });
      }
    }
  }
  return out;
}

/** Question → 学生端公开形态（与 attempt-service.publicOfSnapshot 同口径） */
function toPublic(question: Question): QuestionPublic {
  return questionPublicSchema.parse({
    id: question.id,
    type: question.type,
    difficulty: question.difficulty,
    knowledge: question.knowledge,
    stemMd: studentStemMd(question),
    ...(question.options !== undefined
      ? { options: question.options.map((option) => option.text) }
      : {}),
    hintCount: question.hints.length,
  });
}

/**
 * 题干最长纯文本片段（渲染后应原样出现在题卡文本里）：
 * 跳过指令行/选项任务列表/围栏/标题行，剥掉行内数学、空位标记与 :mark 标记，
 * 按空白与中文标点切段取最长。片段过短（题干几乎全是公式/指令）时由题型控件
 * 断言兜底，不强求文本 oracle。
 */
function longestPlainText(stemMd: string): string {
  const plain = stemMd
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(?::{1,4}|```|[-*+]\s+\[|\d+[.)]\s|#)/.test(line),
    )
    .join(" ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\[\[[^[\]]*\]\]/g, " ")
    // :mark 行内指令三形态：先剥完整形态 [文本]{属性}，再剥单属性/单文本形态
    .replace(/:[a-zA-Z-]+\[[^\]]*\]\{[^}]*\}/g, " ")
    .replace(/:[a-zA-Z-]+\{[^}]*\}/g, " ")
    .replace(/:[a-zA-Z-]+\[[^\]]*\]/g, " ");
  const chunks = plain.split(/[\s。；，、：？！（）()]+/);
  return chunks.reduce(
    (best, chunk) => (chunk.length > best.length ? chunk : best),
    "",
  );
}

describe("全部样例题目真实题卡渲染（samples/v2 + 完整样例，T7.9）", () => {
  const entries = collectSampleQuestions().map((entry) => [
    entry.source,
    entry.question,
  ] as const);

  it("样例题目语料非空（纯练习文档不被跳过）", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(
      entries.some(([source]) => source.includes("samples/v2/练习样例.md")),
    ).toBe(true);
    expect(
      entries.some(([source]) => source.includes("完整样例.md 块3")),
    ).toBe(true);
  });

  it.each(entries)("%s：题面/公式/控件必要语义齐全", (source, question) => {
    const publicQuestion = toPublic(question);
    // 投影守卫：学生题干不得携带可判定答案的标记（[x] / 非空 [[…]]）
    expect(
      stemMdLeaksAnswers(publicQuestion.stemMd),
      `${source} 学生投影题干不得泄露答案标记`,
    ).toBe(false);

    const handwritten = HANDWRITTEN_TYPES.has(question.type);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container, unmount } = render(
      <QueryClientProvider client={client}>
        <AttemptQuestionCard
          index={0}
          question={publicQuestion}
          answer={undefined}
          onAnswer={() => {}}
          // 手写题需 attemptId 才渲染最终答案/手写区入口；题面测试不涉笔迹上传
          {...(handwritten ? { attemptId: "sample-attempt" } : {})}
        />
      </QueryClientProvider>,
    );

    const article = container.querySelector("article");
    expect(article, `${source} 应渲染题卡 article`).not.toBeNull();
    expect(
      screen.getByText("第 1 题"),
      `${source} 应渲染题号`,
    ).toBeInTheDocument();

    // 题面文本 oracle：题干最长的纯文本片段出现在渲染结果里
    const plain = longestPlainText(question.stemMd);
    if (plain.length >= 4) {
      expect(
        (article?.textContent ?? "").replace(/\s+/g, ""),
        `${source} 题面应包含纯文本片段「${plain}」`,
      ).toContain(plain);
    }

    // 公式：题干或选项含数学记号时 KaTeX 必须实际渲染（版本错配类回归）
    const hasMath =
      publicQuestion.stemMd.includes("$") ||
      (publicQuestion.options ?? []).some((option) => option.includes("$"));
    if (hasMath) {
      expect(
        container.querySelector(".katex"),
        `${source} 数学应经 KaTeX 渲染`,
      ).not.toBeNull();
    }

    // 题型控件（必要语义，不做交互流——交互由题卡组件测试覆盖）
    switch (question.type) {
      case "judge":
        expect(screen.getByRole("radio", { name: "对" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "错" })).toBeInTheDocument();
        expect(article?.textContent ?? "").toContain("（　）");
        break;
      case "choice":
        expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(
          publicQuestion.options?.length ?? 0,
        );
        break;
      case "multi":
        expect(
          container.querySelectorAll('input[type="checkbox"]'),
        ).toHaveLength(publicQuestion.options?.length ?? 0);
        break;
      case "fill": {
        const blanks = question.answers?.kind === "fill"
          ? question.answers.blanks.length
          : 0;
        expect(blanks, `${source} 填空题应有答案空位`).toBeGreaterThan(0);
        for (let i = 1; i <= blanks; i += 1) {
          expect(
            screen.getByLabelText(`第${i}空`),
            `${source} 第 ${i} 空输入框`,
          ).toBeInTheDocument();
        }
        break;
      }
      default:
        expect(
          screen.getByRole("button", { name: /展开手写区/ }),
          `${source} 手写题应有手写区入口`,
        ).toBeInTheDocument();
        expect(
          screen.getByLabelText("最终答案"),
          `${source} 手写题应有最终答案输入`,
        ).toBeInTheDocument();
        break;
    }

    unmount();
  });
});
