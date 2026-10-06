import { describe, expect, it } from "vitest";
import {
  buildStaticQuestionMaterial,
  STATIC_INTERACTION_NOTE,
} from "./question-materials";

/**
 * T6R.12 前端授权静态题目素材导出模块测试：
 * - 完整选项：选项以纯字母序列出，不带正误标记；LaTeX 与表格原样保留；
 * - 媒体引用：::image src 进素材清单（供下载/打包）；
 * - 图表静态导出：::graph 收集为待渲染图表（参数保留），md 内换成静态说明；
 * - 复杂交互缺状态明确标记：fold/steps 容器注「交互内容静态导出（交互
   状态未记录）」，内容本身保留——不伪造「当时画面」；
 * - 学生角色守卫：题干仍含答案标记（上游投影缺失）→ 拒绝生成并抛错，
   绝不把含答案题干静默降级成材料；
 * - 教师角色不做该守卫（answer/solution 层题干本就含 [[答案]]）。
 */

const H = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("buildStaticQuestionMaterial（静态题目素材）", () => {
  it("完整选项 + 学生答案：选项字母序列出、无正误标记；LaTeX 与表格原样保留", () => {
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd:
        "化简 $\\frac{2}{4}$ 后比较大小：\n\n| 数 | 含义 |\n| --- | --- |\n| $a$ | 甲数 |\n",
      options: ["$\\frac{1}{2}$", "0.6", "$\\frac{1}{3}$"],
      answerText: "B",
      questionNo: 3,
    });
    expect(material.markdown).toContain("### 题目 3");
    expect(material.markdown).toContain("$\\frac{2}{4}$");
    expect(material.markdown).toContain("| 数 | 含义 |");
    expect(material.markdown).toContain("A. $\\frac{1}{2}$");
    expect(material.markdown).toContain("B. 0.6");
    expect(material.markdown).toContain("C. $\\frac{1}{3}$");
    // 无任务列表标记（不泄露正误）
    expect(material.markdown).not.toContain("[x]");
    expect(material.markdown).toContain("**学生答案**：B");
    expect(material.mediaSrcs).toEqual([]);
    expect(material.graphFigures).toEqual([]);
  });

  it("媒体引用收集：::image src 进素材清单，指令行保留在 md", () => {
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd: `看图回答：\n\n::image{src="blobs/media/${H}.png" alt="数轴"}\n\n如图所示。`,
    });
    expect(material.mediaSrcs).toEqual([`blobs/media/${H}.png`]);
    expect(material.markdown).toContain(`::image{src="blobs/media/${H}.png"`);
  });

  it("图表静态导出：::graph 收集参数、md 换成静态说明（原始指令保留为补充）", () => {
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd: '观察函数图像：\n\n::graph{fn="x^2" range="-3,3"}\n\n回答问题。',
    });
    expect(material.graphFigures).toEqual([{ fn: "x^2", range: "-3,3" }]);
    expect(material.markdown).not.toContain(
      '::graph{fn="x^2" range="-3,3"}\n\n回答',
    );
    expect(material.markdown).toContain("函数图像");
    expect(material.markdown).toContain("x^2");
    // 原始指令作为补充保留（不要求读者猜原始图形）
    expect(material.markdown).toContain('::graph{fn="x^2"');
    expect(material.interactionNotes.length).toBeGreaterThan(0);
  });

  it("复杂交互缺状态明确标记：fold/steps 注静态导出标记，内容保留", () => {
    const stem = [
      "阅读材料：",
      "",
      ':::fold{title="拓展材料"}',
      "折叠块内的重要线索文字。",
      ":::",
      "",
      "::::steps",
      ':::step{title="第 1 步"}',
      "先化简。",
      ":::",
      "::::",
    ].join("\n");
    const material = buildStaticQuestionMaterial({
      role: "student",
      stemMd: stem,
    });
    expect(material.markdown).toContain(STATIC_INTERACTION_NOTE);
    expect(material.markdown).toContain("折叠块内的重要线索文字。");
    expect(material.markdown).toContain("先化简。");
    // 不伪造当时画面：说明只声明「静态导出 + 状态未记录」，不声称是截图
    expect(material.markdown).not.toContain("截图");
    expect(material.interactionNotes.some((n) => n.includes("折叠"))).toBe(
      true,
    );
    expect(material.interactionNotes.some((n) => n.includes("分步"))).toBe(
      true,
    );
  });

  it("学生角色守卫：题干含答案标记（上游投影缺失）→ 抛错拒绝生成", () => {
    expect(() =>
      buildStaticQuestionMaterial({
        role: "student",
        stemMd: "计算 [[42]] 的相反数。",
      }),
    ).toThrow(/答案标记/);
    // 任务列表（选项正误标记）同样拒绝
    expect(() =>
      buildStaticQuestionMaterial({
        role: "student",
        stemMd: "选择：\n\n- [x] 甲\n- [ ] 乙\n",
      }),
    ).toThrow(/答案标记/);
  });

  it("教师角色不做投影守卫（原文含 [[答案]] 是合法输入）", () => {
    const material = buildStaticQuestionMaterial({
      role: "teacher",
      stemMd: "计算 [[42]] 的相反数。",
    });
    expect(material.markdown).toContain("[[42]]");
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
