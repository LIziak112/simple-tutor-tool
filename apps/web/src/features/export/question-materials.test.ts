import { describe, expect, it } from "vitest";
import { buildStaticQuestionMaterial } from "./question-materials";

/**
 * question-materials 前端薄壳测试（T6R.13 起纯函数实现移入 @tutor/md-dsl，
 * 行为测试随迁 packages/md-dsl/src/v2/static-material.test.ts；此处只留
 * DOM 渲染（renderGraphFigurePng）与 re-export 冒烟）。
 */

describe("re-export 冒烟（纯函数来自 md-dsl 单一实现）", () => {
  it("buildStaticQuestionMaterial 经 web 路径可用且为学生角色守卫", () => {
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd: "纯文字题干",
    });
    expect(material.markdown).toContain("纯文字题干");
    expect(() =>
      buildStaticQuestionMaterial({ role: "student", stemMd: "计算 [[42]]" }),
    ).toThrow(/答案标记/);
  });
});

describe("renderGraphFigurePng（图表静态化，显式失败语义）", () => {
  it("任何环境失败都不抛错：返回 ok=false 与可读原因（不伪造图片、无截图兜底）", async () => {
    const { renderGraphFigurePng } = await import("./question-materials");
    const host = document.createElement("div");
    // jsdom 无 Canvas 实现（getContext 缺失/抛错或 URL.createObjectURL 未实现），
    // 全部落入显式失败分支——锁定「失败返回原因而非抛错/伪造」的契约
    const result = await renderGraphFigurePng(host, { fn: "x^2" });
    if (result.ok) {
      expect(result.dataUrl.startsWith("data:image/png")).toBe(true);
    } else {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
