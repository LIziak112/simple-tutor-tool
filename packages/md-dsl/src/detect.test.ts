import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectVersion, detectVersionDetailed } from "./detect";

/** 识别依据（docs/技术架构与实施方案.md §5.1 末段「v1 兼容」）：
 * 有 YAML frontmatter（kind:）→ 2；出现 v1 特征（#### 题 N / 【题型】 / <!-- ANSWER -->）→ 1；
 * 都无/都有 → 返回最可能的，并在 detailed 结果里给出 reason 与 confident 标记。 */

const readSample = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const v1Sample = readSample("../../../samples/v1/示例练习.md");
const v2Samples = [
  readSample("../../../samples/v2/练习样例.md"),
  readSample("../../../samples/v2/讲义样例.md"),
  readSample("../../../samples/v2/混合样例.md"),
];

describe("detectVersion：样例文档", () => {
  it("v1 旧样例 → 1", () => {
    expect(detectVersion(v1Sample)).toBe(1);
  });

  it.each(v2Samples.map((md, i) => [`样例 #${i}`, md] as const))(
    "v2 样例 %s → 2",
    (_name, md) => {
      expect(detectVersion(md)).toBe(2);
    },
  );
});

describe("detectVersion：特征判定", () => {
  it("题号行是最强的 v1 特征（无 frontmatter 时）", () => {
    expect(detectVersion("#### 题 1（★）\n判断。\n")).toBe(1);
  });

  it("题号行变体（无括号/全角括号/无空格）也识别为 v1", () => {
    expect(detectVersion("####题2\n题干。\n")).toBe(1);
    expect(detectVersion("#### 题 3（★★）\n题干。\n")).toBe(1);
  });

  it("仅 ANSWER 注释（无题号行）→ 1（v1 特征）", () => {
    expect(detectVersion("<!-- ANSWER: B -->\n")).toBe(1);
  });

  it("仅【题型】/【考点】/ UNIT 注释 → 1", () => {
    expect(detectVersion("【题型】判断\n")).toBe(1);
    expect(detectVersion("<!-- UNIT: 练习一|第1讲|加法 -->\n")).toBe(1);
  });

  it("frontmatter 声明 kind → 2（文档声明版本是权威，优先于 v1 特征）", () => {
    expect(detectVersion("---\nkind: practice\n---\n\n正文。\n")).toBe(2);
  });

  it("冲突（frontmatter kind + v1 题号行）→ 2，reason 说明冲突（可能误贴旧内容）", () => {
    const md =
      "---\nkind: practice\nunit: 练习\n---\n\n#### 题 1（★）\n判断。\n";
    const detailed = detectVersionDetailed(md);
    expect(detailed.version).toBe(2);
    expect(detailed.reason).toContain("v1");
    expect(detailed.confident).toBe(true);
  });

  it("v2 文档正文的 #### 四级标题（非「题 N」形态）不误判为 v1", () => {
    const md = [
      "---",
      "kind: practice",
      "---",
      "",
      "::::question{type=judge difficulty=1}",
      "判断。[[正确]]",
      "::::",
      "",
      "#### 补充说明",
      "普通四级标题。",
      "",
    ].join("\n");
    expect(detectVersion(md)).toBe(2);
  });

  it("v1 特征出现在 v2 文档代码块内不参与判定（有 frontmatter 时以声明为准，无声明时不误判）", () => {
    const fenced = [
      "普通文档，无 frontmatter。",
      "",
      "```",
      "<!-- ANSWER: B -->",
      "```",
      "",
    ].join("\n");
    expect(detectVersion(fenced)).toBe(2);
    expect(detectVersionDetailed(fenced).confident).toBe(false);
  });

  it("无任何特征：返回缺省 2，confident=false，reason 引导人工确认", () => {
    const detailed = detectVersionDetailed("只是一段普通文本。\n");
    expect(detailed.version).toBe(2);
    expect(detailed.confident).toBe(false);
    expect(detailed.reason.length).toBeGreaterThan(0);
  });

  it("只有 frontmatter 围栏但没有 kind → 不算 v2 声明，按其余特征判定", () => {
    const md = "---\ntitle: 随手记\n---\n\n#### 题 1（★）\n判断。\n";
    expect(detectVersion(md)).toBe(1);
  });

  it("reason 始终非空；空输入不抛异常", () => {
    for (const md of ["", "\n", v1Sample, ...v2Samples]) {
      const detailed = detectVersionDetailed(md);
      expect(detailed.reason.length).toBeGreaterThan(0);
    }
  });
});
