import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import {
  type Question,
  type QuestionPublic,
  questionPublicSchema,
} from "@tutor/contract";
import {
  parseDocument,
  stemMdLeaksAnswers,
  studentStemMd,
} from "@tutor/md-dsl";
import { describe, expect, it, vi } from "vitest";
import {
  allSampleDocs,
  longestPlainTextOf,
  mathNodePresentOf,
} from "../../../../../test-support/dsl-samples.ts";
import { AttemptQuestionCard } from "./AttemptQuestionCard";
import { HANDWRITTEN_TYPES } from "./answer-format";

/**
 * TT-06 新题型（matching/ordering/response，完整样例自 TT-06 起含此类题）：
 * 呈现层此前 prepareQuestion 显式 throw（§7.1 不静默降级，prepare-question.ts
 * 守卫）。response 已随 QM-09（TT-08b）转进真实控件断言；matching/ordering
 * 呈现控件属 QM-13，守卫保持武装——QM-13 落地后渲染不再掷错、断言翻红，
 * 强制转进真实控件断言（qm-corpus 注册表探针同款失败驱动转正，不存在忘记路径）。
 */
const QM13_PENDING_TYPES: ReadonlySet<string> = new Set([
  "matching",
  "ordering",
]);

/**
 * T7.9 全部练习/混合/讲练样例题目的真实题卡渲染回归：
 * 自动发现 samples/v2 全部 .md + 完整样例全部 markdown 块 → parseDocument →
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

/** 全语料题目：samples/v2 自动发现的练习/混合/讲练文档 + 完整样例全部 markdown 块 */
function collectSampleQuestions(): Array<{
  source: string;
  question: Question;
}> {
  const out: Array<{ source: string; question: Question }> = [];
  for (const doc of allSampleDocs()) {
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
    // QM-09：response 字数建议随公开投影下发（仅提示不校验）
    ...(question.wordMin !== undefined ? { wordMin: question.wordMin } : {}),
    ...(question.wordMax !== undefined ? { wordMax: question.wordMax } : {}),
    hintCount: question.hints.length,
  });
}

describe("全部样例题目真实题卡渲染（samples/v2 + 完整样例，T7.9）", () => {
  const entries = collectSampleQuestions().map(
    (entry) => [entry.source, entry.question] as const,
  );

  it("样例题目语料非空（纯练习文档不被跳过）", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(
      entries.some(([source]) => source.includes("samples/v2/练习样例.md")),
    ).toBe(true);
    expect(entries.some(([source]) => source.includes("完整样例.md 块3"))).toBe(
      true,
    );
  });

  it.each(entries)("%s：题面/公式/控件必要语义齐全", (source, question) => {
    const publicQuestion = toPublic(question);
    // 投影守卫：学生题干不得携带可判定答案的标记（[x] / 非空 [[…]]）
    expect(
      stemMdLeaksAnswers(publicQuestion.stemMd),
      `${source} 学生投影题干不得泄露答案标记`,
    ).toBe(false);

    if (QM13_PENDING_TYPES.has(question.type)) {
      // 新题型守卫断言：渲染必须掷 QM-13 未接入错误，而不是产出作答面
      const guardClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      expect(
        () =>
          render(
            <QueryClientProvider client={guardClient}>
              <AttemptQuestionCard
                index={0}
                question={publicQuestion}
                answer={undefined}
                onAnswer={() => {}}
              />
            </QueryClientProvider>,
          ),
        `${source} QM-13 前新题型须掷守卫错误而非渲染作答面`,
      ).toThrow(/QM-13 呈现层落地前不应对学生下发/);
      return;
    }

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

    // 题面文本 oracle：题干最长的纯文本片段（AST 口径，见 dsl-samples）出现在渲染结果里；
    // 片段过短（题干几乎全是公式/指令）时由题型控件断言兜底
    const plain = longestPlainTextOf(question.stemMd);
    if (plain.length >= 4) {
      expect(
        (article?.textContent ?? "").replace(/\s+/g, ""),
        `${source} 题面应包含纯文本片段「${plain}」`,
      ).toContain(plain);
    }

    // 公式：题干或选项存在数学节点时 KaTeX 必须实际渲染（版本错配类回归；
    // AST 判定——字面 $（货币等）不是数学环境，不误报）
    const hasMath =
      mathNodePresentOf(question.stemMd) ||
      (publicQuestion.options ?? []).some((option) =>
        mathNodePresentOf(option),
      );
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
        // 空标记在题尾时经 judgeStemOf 渲染为（　）；句中标记渲染为下划线
        // 空框（合法形态，不在此断言），与题卡 judgeStemOf 的行尾锚定同口径
        if (/\[\[\]\]\s*$/.test(publicQuestion.stemMd)) {
          expect(article?.textContent ?? "").toContain("（　）");
        }
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
        const blanks =
          question.answers?.kind === "fill"
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
      case "response":
        // QM-09（TT-08b）转正：开放作答真实控件——可选标题 + 多行正文 +
        // 手写区入口（正式手写与正文并存，D14）；没有单行最终答案输入
        expect(
          screen.getByRole("textbox", { name: "标题（可选）" }),
          `${source} 开放作答应有可选标题输入`,
        ).toBeInTheDocument();
        expect(
          screen.getByRole("textbox", { name: "正文" }),
          `${source} 开放作答应有正文输入`,
        ).toBeInTheDocument();
        expect(
          screen.queryByLabelText("最终答案"),
          `${source} 开放作答不应有单行最终答案输入`,
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /手写作答/ }),
          `${source} 开放作答应有手写区入口（与正文并存）`,
        ).toBeInTheDocument();
        // 字数建议（word-min/max 携带时展示；口径单源契约 countResponseWords）
        if (question.wordMin !== undefined || question.wordMax !== undefined) {
          expect(
            article?.textContent ?? "",
            `${source} 开放作答应展示字数建议`,
          ).toMatch(/建议.*字/);
        }
        break;
      default:
        expect(
          screen.getByRole("button", { name: /手写作答/ }),
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
