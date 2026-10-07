import { readFileSync } from "node:fs";
// 闸门修正（T6R.17 审查）：题型全集从契约单源派生，不手抄枚举（规则 1 契约优先）
import { questionTypeSchema } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { analyzeImport } from "./content-service";

/**
 * T6R.17 人工验收样本卷守护测试（e2e/fixtures/ai-review-samples.md）：
 * 样本卷必须始终能走通与 POST /api/teacher/import/commit 完全相同的解析管线
 * （content-service 的 analyzeImport = lintDocument 直通入口，preview 与 commit
 * 共用），且解析出 1 个单元 8 题、无 error 级 issue、每题 type 合法、题干按序带
 * （样本N：…）标注——样本卷被手改坏时先在这里红，而不是等用户导入时才发现。
 *
 * 路径定位：仓内既有先例（mcp.test.ts / library.test.ts 读 samples/v2/）用
 * import.meta.url 相对上溯到仓库根；本文件在 apps/server/src/services/ 下，
 * 四级 `../`（services → src → server → apps）即仓库根，再进 e2e/fixtures/。
 */
const FIXTURE_MD = readFileSync(
  new URL("../../../../e2e/fixtures/ai-review-samples.md", import.meta.url),
  "utf8",
);

/** 解析器认可的题型全集（契约 questionTypeSchema 单源派生，勿手抄） */
const LEGAL_TYPES = new Set<string>(questionTypeSchema.options);

/** 8 类样本的题干标注序号（与样本卷题序一一对应） */
const SAMPLE_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"] as const;

describe("ai-review-samples.md 样本卷守护（T6R.17）", () => {
  const { issues, parsed } = analyzeImport(FIXTURE_MD);
  const questions = parsed.units[0]?.questions ?? [];

  it("解析无 error 级 issue（该档位导入 commit 会被 422 LINT_ERROR 拒绝）", () => {
    expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
  });

  it("解析为 1 个单元共 8 题（8 类样本一题一类）", () => {
    expect(parsed.units).toHaveLength(1);
    expect(questions).toHaveLength(8);
  });

  it("每题 type 合法，且与设计分布一致（solve×3、choice×3、apply、judge）", () => {
    const types = questions.map((question) => question.type);
    for (const type of types) {
      expect(LEGAL_TYPES.has(type), `题型 ${type} 不在解析器合法值清单内`).toBe(
        true,
      );
    }
    expect(types).toEqual([
      "solve",
      "apply",
      "choice",
      "solve",
      "choice",
      "solve",
      "judge",
      "choice",
    ]);
  });

  it("题干按序带（样本①：…）～（样本⑧：…）用途标注", () => {
    questions.forEach((question, index) => {
      const mark = SAMPLE_MARKS[index];
      expect(
        question.stemMd.includes(`（样本${mark}：`),
        `第 ${index + 1} 题题干应含（样本${mark}：…）标注`,
      ).toBe(true);
    });
  });

  it("样本⑥带两条提示（多提示场景；「已有提示」痕迹由样本⑤操作制造），全部题带详解", () => {
    expect(questions[5]?.hints).toHaveLength(2);
    for (const question of questions) {
      expect(question.solutionMd).toBeDefined();
    }
  });
});
