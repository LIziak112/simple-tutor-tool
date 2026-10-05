import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type LintIssue,
  parsedDocumentSchema,
  type Question,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseV1 } from "./parse";

/**
 * v1 兼容解析测试（T1.6）。
 *
 * 行为规格 = v1 仓库（main 历史提交 b4ee184）的 parser.py 与
 * docs/01_任务安排与契约.md §4（解析规则）、§1（content.json schema）。
 * 「人工推演」标记的断言：依据上述旧文档规则对样例逐题推演的预期，
 * 未与旧版（Python）解析器实际输出做过机器对照（见任务报告）。
 */

/** v1 旧样例（自 b4ee184 恢复，长期回归夹具） */
const samplePath = fileURLToPath(
  new URL("../../../../samples/v1/示例练习.md", import.meta.url),
);
const sample = readFileSync(samplePath, "utf8");

const parsed = parseV1(sample);
const unit = parsed.units[0];
const questions = unit?.questions ?? [];
const codes = (issues: LintIssue[]): string[] => issues.map((i) => i.code);
const byId = (id: string): Question | undefined =>
  questions.find((q) => q.id === id);

describe("parseV1：旧样例（人工推演预期，八题覆盖 v1 六种题型）", () => {
  it("合成 frontmatter：kind 一律 practice，dsl=1，unit/lecture/topic 取自 UNIT 注释", () => {
    expect(parsed.frontmatter).toEqual({
      kind: "practice",
      dsl: 1,
      unit: "练习四",
      lecture: "第4讲",
      topic: "有理数加减混合",
    });
  });

  it("H1 与引用块所在的无题首段不入库；产出恰一个单元，元信息正确", () => {
    expect(parsed.units).toHaveLength(1);
    expect(unit?.id).toBe("练习四");
    expect(unit?.title).toBe("练习四");
    expect(unit?.topic).toBe("有理数加减混合");
    expect(unit?.lectureTitle).toBe("第4讲");
    expect(parsed.lectures).toEqual([]);
  });

  it("题数 8，缺省 id 为「单元-题号」（与旧版 {单元id}-{number} 规则一致）", () => {
    expect(questions).toHaveLength(8);
    expect(questions.map((q) => q.id)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-3",
      "练习四-4",
      "练习四-5",
      "练习四-6",
      "练习四-7",
      "练习四-8",
    ]);
  });

  it("题型映射：判断→judge 填空→fill 选择→choice 计算→solve 应用→apply 找错→find-error", () => {
    expect(questions.map((q) => q.type)).toEqual([
      "judge",
      "fill",
      "choice",
      "solve",
      "solve",
      "fill",
      "find-error",
      "apply",
    ]);
  });

  it("难度 = ★ 个数（1~3 原样保留）", () => {
    expect(questions.map((q) => q.difficulty)).toEqual([
      1, 2, 2, 2, 3, 1, 2, 3,
    ]);
  });

  it("判断题：ANSWER「正确」按 v1 判分语义集映射为 value: true", () => {
    expect(byId("练习四-1")?.answers).toEqual({ kind: "judge", value: true });
  });

  it("填空：ANSWER 按 ;; 拆分为空序 answers.blanks（题 2 两空、题 6 一空）", () => {
    expect(byId("练习四-2")?.answers).toEqual({
      kind: "fill",
      blanks: [["4"], ["-7"]],
    });
    expect(byId("练习四-6")?.answers).toEqual({
      kind: "fill",
      blanks: [["6"]],
    });
  });

  it("填空 stemMd 保留 v1 原文 ____ 占位（原文是真相，转 v2 时才替换）", () => {
    expect(byId("练习四-2")?.stemMd).toBe(
      "填空：$(-3)+7=$ ____；$(-2)+(-5)=$ ____。",
    );
    expect(byId("练习四-6")?.stemMd).toBe("填空：$|-6|=$ ____。");
  });

  it("选择题：A.~D. 行抽为 options（纯文本，正确项以 answers 为权威），ANSWER 字母映射下标", () => {
    const choice = byId("练习四-3");
    expect(choice?.options).toEqual([
      { text: "$-10$" },
      { text: "$4$" },
      { text: "$-4$" },
      { text: "$10$" },
    ]);
    expect(choice?.answers).toEqual({ kind: "choice", index: 1 });
    expect(choice?.stemMd).toBe("计算 $-3-(-7)$ 的结果是（　）。");
  });

  it("计算/找错/应用：ANSWER 文本进 answers.final（含长文本的找错题）", () => {
    expect(byId("练习四-4")?.answers).toEqual({ kind: "final", answer: "0" });
    expect(byId("练习四-5")?.answers).toEqual({ kind: "final", answer: "-4" });
    expect(byId("练习四-8")?.answers).toEqual({ kind: "final", answer: "-1" });
    expect(byId("练习四-7")?.answers).toEqual({
      kind: "final",
      answer: "错在没有把减法转化为加上相反数，正确解法为 $3-(-4)=3+4=7$",
    });
  });

  it("考点归一为单元素数组", () => {
    expect(byId("练习四-1")?.knowledge).toEqual(["相反数的意义"]);
    expect(byId("练习四-3")?.knowledge).toEqual(["有理数减法"]);
  });

  it("详解：<details> 内容剔除 <summary> 行后进 solutionMd，【思路】等结构保留", () => {
    expect(byId("练习四-1")?.solutionMd).toBe(
      [
        "【思路】互为相反数的两个数只有符号不同，例如 $5$ 与 $-5$。",
        "",
        "【过程】设这个数为 $a$，则 $a+(-a)=0$，所以和一定为 $0$，本题说法正确。",
        "",
        '【易错】把"相反数"与"倒数"混淆；$-a$ 是 $a$ 的相反数，而不是 $a$ 的倒数。',
      ].join("\n"),
    );
    expect(byId("练习四-1")?.solutionMd).not.toContain("查看详解");
  });

  it("v1 无 hint 概念：hints 恒为空数组", () => {
    for (const question of questions) {
      expect(question.hints).toEqual([]);
    }
  });

  it("sourceMd 保存该题 v1 原文片段（题号行起、去尾空行，供追溯与单题重导）", () => {
    const first = byId("练习四-1")?.sourceMd ?? "";
    expect(first.startsWith("#### 题 1（★）")).toBe(true);
    expect(first).toContain("<!-- ANSWER: 正确 -->");
    expect(first).toContain("<details>");
    expect(first.endsWith("</details>")).toBe(true);
  });

  it("合法样例 0 issue，且输出通过内容契约校验", () => {
    expect(parsed.issues).toEqual([]);
    expect(parsedDocumentSchema.safeParse(parsed).success).toBe(true);
  });

  it("纯函数：同输入重复调用结果一致", () => {
    expect(parseV1(sample)).toEqual(parsed);
  });
});

describe("parseV1：v1 规则边界（对照 parser.py 行为）", () => {
  it("多单元：按 H2 切分，各单元独立 id/lecture/topic；合成 frontmatter 不带 unit", () => {
    const md = [
      "## 练习一 加法",
      "<!-- UNIT: 练习一|第1讲|加法 -->",
      "",
      "#### 题 1（★）",
      "【题型】计算",
      "【考点】加法",
      "计算：$1+1=$ ____。",
      "",
      "<!-- ANSWER: 2 -->",
      "",
      "## 练习二 减法",
      "",
      "#### 题 1（★）",
      "【题型】计算",
      "【考点】减法",
      "计算：$3-1=$ ____。",
      "",
      "<!-- ANSWER: 2 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units).toHaveLength(2);
    // 无 UNIT 注释的第二单元：unit id 取 H2 标题全文，topic 为去编号标题（「练习X」前缀被剥掉）
    expect(result.units.map((u) => u.id)).toEqual(["练习一", "练习二 减法"]);
    expect(result.units[1]?.title).toBe("练习二 减法");
    expect(result.units[1]?.topic).toBe("减法");
    expect(result.units[1]?.lectureTitle).toBeUndefined();
    // 多单元时 frontmatter 只声明 kind/dsl，不挑边
    expect(result.frontmatter).toEqual({ kind: "practice", dsl: 1 });
  });

  it("无 UNIT 注释：unit id 取 H2 标题，topic 为去编号标题（第 X 讲/练习X/数字编号）", () => {
    const md = [
      "## 第4讲 加法——方向参与的合并",
      "",
      "#### 题 1",
      "【题型】判断",
      "判断：$0$ 是整数。",
      "",
      "<!-- ANSWER: 正确 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    const u = result.units[0];
    expect(u?.id).toBe("第4讲 加法——方向参与的合并");
    expect(u?.topic).toBe("加法——方向参与的合并");
    expect(result.frontmatter?.unit).toBe("第4讲 加法——方向参与的合并");
    // 难度缺失（★ 数 0）落到 v2 注册表缺省难度 2
    expect(u?.questions[0]?.difficulty).toBe(2);
  });

  it("全文无 H2 但有题：归入「未命名单元」", () => {
    const md = [
      "#### 题 1（★）",
      "【题型】填空",
      "填空：$1+1=$ ____。",
      "",
      "<!-- ANSWER: 2 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.id).toBe("未命名单元");
    expect(result.units[0]?.questions[0]?.id).toBe("未命名单元-1");
  });

  it("单元内重复题号：id 追加 -2 后缀（v1 去重规则）", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】判断",
      "判断一。",
      "",
      "<!-- ANSWER: 正确 -->",
      "",
      "#### 题 1（★）",
      "【题型】判断",
      "判断二。",
      "",
      "<!-- ANSWER: 错误 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    const ids = result.units[0]?.questions.map((q) => q.id);
    expect(ids).toEqual(["练习-1", "练习-1-2"]);
  });

  it("未知题型：归入手写题 solve 并记 V1_UNKNOWN_TYPE warning（对应 v1 前端「未知类型归手写」）", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】作文",
      "写一段话。",
      "",
      "<!-- ANSWER: 好的 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.type).toBe("solve");
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "final",
      answer: "好的",
    });
    const issue = result.issues.find((i) => i.code === "V1_UNKNOWN_TYPE");
    expect(issue?.level).toBe("warning");
    expect(issue?.message).toContain("作文");
  });

  it("缺【题型】行：归 solve 并记 V1_MISSING_TYPE warning", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "直接写题干。",
      "",
      "<!-- ANSWER: 42 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.type).toBe("solve");
    expect(codes(result.issues)).toContain("V1_MISSING_TYPE");
  });

  it("判断答案按 v1 判分语义集映射：{对,√,T,TRUE,是}→true；{错,×,F,否}→false", () => {
    const mk = (answer: string): string =>
      [
        "## 练习",
        "",
        "#### 题 1（★）",
        "【题型】判断",
        "判断。",
        "",
        `<!-- ANSWER: ${answer} -->`,
        "",
      ].join("\n");
    expect(parseV1(mk("对")).units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: true,
    });
    expect(parseV1(mk("×")).units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: false,
    });
  });

  it("判断答案非法（无法映射）：answers 缺省 + V1_ANSWER_INVALID warning", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】判断",
      "判断。",
      "",
      "<!-- ANSWER: 不知道 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
    expect(codes(result.issues)).toContain("V1_ANSWER_INVALID");
  });

  it("客观题缺 ANSWER 注释：answers 缺省 + V1_ANSWER_MISSING warning（题目仍入库）", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】填空",
      "填空：$1+1=$ ____。",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.stemMd).toContain("____");
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
    expect(codes(result.issues)).toContain("V1_ANSWER_MISSING");
  });

  it("选择题答案字母越界（无对应选项）：answers 缺省 + V1_ANSWER_INVALID", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】选择",
      "选一个：",
      "A. 甲",
      "B. 乙",
      "",
      "<!-- ANSWER: D -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.options).toHaveLength(2);
    expect(result.units[0]?.questions[0]?.answers).toBeUndefined();
    expect(codes(result.issues)).toContain("V1_ANSWER_INVALID");
  });

  it("选择题多个正确下标（;; 多段）：映射 multi + V1_CHOICE_MULTI_ANSWER warning", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】选择",
      "选：",
      "A. 甲",
      "B. 乙",
      "C. 丙",
      "",
      "<!-- ANSWER: A;; C -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "multi",
      indexes: [0, 2],
    });
    expect(codes(result.issues)).toContain("V1_CHOICE_MULTI_ANSWER");
  });

  it("填空答案数与题干 ____ 数不一致：仍按 v1 权威空序产出 blanks，记 V1_FILL_BLANK_MISMATCH warning", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】填空",
      "填空：$1+1=$ ____；$2+2=$ ____。",
      "",
      "<!-- ANSWER: 2 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "fill",
      blanks: [["2"]],
    });
    expect(codes(result.issues)).toContain("V1_FILL_BLANK_MISMATCH");
  });

  it("难度星超过 5：收敛到 5 + V1_DIFFICULTY_CLAMPED warning", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★★★★★★）",
      "【题型】判断",
      "判断。",
      "",
      "<!-- ANSWER: 正确 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.difficulty).toBe(5);
    expect(codes(result.issues)).toContain("V1_DIFFICULTY_CLAMPED");
  });

  it("详解容忍缺失 </details>（未闭合取到题末）；无详解则 solutionMd 缺省", () => {
    const unclosed = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】判断",
      "判断。",
      "",
      "<!-- ANSWER: 正确 -->",
      "",
      "<details>",
      "详解正文。",
      "",
    ].join("\n");
    const closed = parseV1(unclosed);
    expect(closed.units[0]?.questions[0]?.solutionMd).toBe("详解正文。");

    const none = parseV1(
      [
        "## 练习",
        "",
        "#### 题 1（★）",
        "【题型】判断",
        "判断。",
        "",
        "<!-- ANSWER: 正确 -->",
        "",
      ].join("\n"),
    );
    expect(none.units[0]?.questions[0]?.solutionMd).toBeUndefined();
  });

  it("兼容 CRLF 与 UTF-8 BOM，容忍题内空行", () => {
    const md =
      "\uFEFF## 练习\r\n\r\n#### 题 1（★）\r\n【题型】判断\r\n\r\n判断。\r\n\r\n<!-- ANSWER: 正确 -->\r\n";
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.stemMd).toBe("判断。");
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "judge",
      value: true,
    });
  });

  it("选项分隔符兼容 A. / A． / A、（v1 选项正则）", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】选择",
      "选：",
      "A. 甲",
      "B．乙",
      "C、丙",
      "",
      "<!-- ANSWER: B -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions[0]?.options?.map((o) => o.text)).toEqual([
      "甲",
      "乙",
      "丙",
    ]);
    expect(result.units[0]?.questions[0]?.answers).toEqual({
      kind: "choice",
      index: 1,
    });
  });

  it("题号行格式宽容：全角/半角括号、括号缺失、#### 与题之间无空格", () => {
    const md = [
      "## 练习",
      "",
      "####题2（★★）",
      "【题型】判断",
      "判断。",
      "",
      "<!-- ANSWER: 错误 -->",
      "",
    ].join("\n");
    const result = parseV1(md);
    expect(result.units[0]?.questions).toHaveLength(1);
    expect(result.units[0]?.questions[0]?.id).toBe("练习-2");
    expect(result.units[0]?.questions[0]?.difficulty).toBe(2);
  });

  it("空文档 / 纯讲义无题文档：0 单元，不抛异常，frontmatter 仍合成", () => {
    const empty = parseV1("");
    expect(empty.units).toEqual([]);
    expect(empty.frontmatter).toEqual({ kind: "practice", dsl: 1 });
    expect(empty.issues).toEqual([]);
    const noQuestion = parseV1("## 练习\n\n没有题目的段落。\n");
    expect(noQuestion.units).toEqual([]);
  });
});

describe("parseV1：健壮性（纯函数不抛异常）", () => {
  const hostileInputs = [
    "",
    "\n\n\n",
    "\u0000\uFFFF乱码???<script>alert(1)</script>]]][[[",
    "####",
    "#### 题",
    "#### 题 x（★）",
    "<!-- ANSWER:",
    "#### 题 1（★）\n【题型】\n【考点】",
    "<details>",
    "## \n\n#### 题 1",
    sample.slice(0, Math.floor(sample.length / 3)),
    `是的${String.fromCodePoint(0x10ffff)}`,
  ];

  it.each(hostileInputs.map((text, i) => [`输入 #${i}`, text] as const))(
    "不抛异常且输出过契约：%s",
    (_name, text) => {
      expect(() => parseV1(text)).not.toThrow();
      const result = parseV1(text);
      expect(parsedDocumentSchema.safeParse(result).success).toBe(true);
      expect(Array.isArray(result.issues)).toBe(true);
    },
  );
});
