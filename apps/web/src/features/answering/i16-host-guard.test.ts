import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * I16 轻量守护（UA-03 落地面）：迁移后的宿主不再出现按答案 kind / 题型
 * 字面量的判别分支——呈现分支收进登记表与调度边界（answering/index.tsx），
 * 选项集合提取收进 views/choice，纸面角色走 questionBindings.paperRole。
 *
 * 与 UA-05 全量守护（AST 判别、白名单基线，§6.3/§11.2）的关系：本测试只锁
 * 本单迁移过的宿主文件，且模式按 §6.3 D 澄清逐文件校准——「phase/notePrep
 * 的 kind=choice 是草稿同步对话框态」「讲练 block.type=md/question 是文档块
 * 类型」都不是答案 kind/题型判别，不在此禁；全量白名单与 AST 守护留 UA-05。
 */

/** 读取 web 源码（cwd 兼容仓库根与 apps/web 两种运行目录） */
function sourceOf(relative: string): string {
  const candidates = [process.cwd(), join(process.cwd(), "apps/web")];
  for (const root of candidates) {
    try {
      return readFileSync(join(root, relative), "utf-8");
    } catch {
      // 试下一候选目录
    }
  }
  throw new Error(`找不到源文件 ${relative}（cwd=${process.cwd()}）`);
}

/** 答案 kind 字面量判别（judge/choice/multi/fill/final） */
const ANSWER_KIND_BRANCH =
  /\.kind\s*(?:===|!==)\s*"(?:judge|choice|multi|fill|final)"/;
/** 题型字面量判别（旧七型） */
const QUESTION_TYPE_BRANCH =
  /\.type\s*(?:===|!==)\s*"(?:judge|choice|multi|fill|solve|apply|find-error)"/;
/** 手写集合直接消费（应走 questionBindings.paperRole；派生常量本体在 contract/answer-format） */
const HANDWRITTEN_USE =
  /HANDWRITTEN_TYPES\.has|HANDWRITTEN_QUESTION_TYPES\.includes/;

describe("I16 守护：迁移后宿主无答案 kind/题型字面量分支", () => {
  it.each([
    "src/features/attempt/QuestionSurface.tsx",
    "src/features/attempt/ResultAnswerComparison.tsx",
    "src/features/attempt/question-completion.ts",
    "src/features/attempt/AttemptResultParts.tsx",
    "src/features/student/wrong-questions-ui.tsx",
    "src/features/teacher-attempts/AttemptDetailQuestionCard.tsx",
    // AttemptSession 的 notePrep/outcome.kind 是对话框态（§6.3 D），只禁手写集合
  ])("%s 无 kind/题型判别", (relative) => {
    const source = sourceOf(relative);
    expect(
      ANSWER_KIND_BRANCH.test(source),
      `${relative} 不应出现答案 kind 字面量判别（呈现分支归登记表）`,
    ).toBe(false);
    expect(
      QUESTION_TYPE_BRANCH.test(source),
      `${relative} 不应出现题型字面量判别（呈现分支归登记表）`,
    ).toBe(false);
  });

  it.each([
    // AttemptDetailQuestionCard 的 HANDWRITTEN_TYPES 消费是 §6.3 C 纸面角色
    // 既有基线（不属本单四现场），不在此列；此处只锁本单替换过的两现场
    "src/features/attempt/AttemptSession.tsx",
    "src/pages/student/StudentLessonPage.tsx",
  ])(
    "%s 纸面角色不消费手写集合（走 questionBindings.paperRole）",
    (relative) => {
      const source = sourceOf(relative);
      expect(
        HANDWRITTEN_USE.test(source),
        `${relative} 纸面角色应经 questionBindings.paperRole 判定`,
      ).toBe(false);
      expect(source).not.toContain(
        'HANDWRITTEN_QUESTION_TYPES } from "@tutor/contract"',
      );
    },
  );

  it("answer-format 兼容代理无 kind 分支（UA-01 起单行委托）", () => {
    const source = sourceOf("src/features/attempt/answer-format.ts");
    expect(ANSWER_KIND_BRANCH.test(source)).toBe(false);
  });
});
