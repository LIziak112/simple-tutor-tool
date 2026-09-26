import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Question } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { lintDocument } from "../lint/lint";
import { parseV1 } from "./parse";
import { v1ToV2, v1ToV2Units } from "./toV2";

/**
 * v1 → v2 转换与往返测试（T1.6）：
 * - 转换输出必须是合法 v2 文本（lintDocument 0 error——往返质量的关键断言）；
 * - toV2 输出再经 v2 解析，与 v1 解析逐题结构一致（id/type/difficulty/answers/
 *   options 语义/knowledge/hints/solutionMd；stemMd 因填空 ____→[[…]]、判断追加
 *   标记、选择题选项转任务列表而形态变化，用「独立构造的期望文本」精确断言）。
 * 「人工推演」标记的期望同 parse.test.ts 头注释说明。
 */

const samplePath = fileURLToPath(
  new URL("../../../../samples/v1/示例练习.md", import.meta.url),
);
const sample = readFileSync(samplePath, "utf8");

const v1Parsed = parseV1(sample);
const v1Questions = v1Parsed.units[0]?.questions ?? [];
const converted = v1ToV2(sample);
const linted = lintDocument(converted);
const roundTripped = linted.parsed;
const v2Questions = roundTripped.units[0]?.questions ?? [];

describe("v1ToV2：转换输出形态", () => {
  it("输出是合法 v2：lintDocument 0 issue", () => {
    expect(linted.issues).toEqual([]);
  });

  it("frontmatter 由 v1 元信息合成（kind/unit/lecture/topic）", () => {
    expect(converted.startsWith("---\n")).toBe(true);
    expect(converted).toContain("kind: practice");
    expect(converted).toContain('unit: "练习四"');
    expect(converted).toContain('lecture: "第4讲"');
    expect(converted).toContain('topic: "有理数加减混合"');
  });

  it("题目容器带 v1 题目 id（显式 id 保证与 v1 解析的缺省 id 一致）", () => {
    expect(converted).toContain('id="练习四-1"');
    expect(converted).toContain('id="练习四-8"');
  });

  it("详解 details 转 :::solution 子指令，ANSWER 注释与 v1 结构标记不再出现", () => {
    expect(converted).toContain(":::solution");
    expect(converted).not.toContain("<!-- ANSWER:");
    expect(converted).not.toContain("<details>");
    expect(converted).not.toContain("【题型】");
    expect(converted).not.toContain("【考点】");
  });
});

describe("v1ToV2 → v2 解析：往返结构一致（样例八题逐题对照）", () => {
  it("单元与题数一致", () => {
    expect(roundTripped.units).toHaveLength(1);
    expect(v2Questions).toHaveLength(v1Questions.length);
    expect(v2Questions.length).toBe(8);
    const v2Unit = roundTripped.units[0];
    expect(v2Unit?.id).toBe(v1Parsed.units[0]?.id);
    expect(v2Unit?.title).toBe(v1Parsed.units[0]?.title);
    expect(v2Unit?.topic).toBe(v1Parsed.units[0]?.topic);
    expect(v2Unit?.lectureTitle).toBe(v1Parsed.units[0]?.lectureTitle);
  });

  it("逐题：id/type/difficulty/knowledge/answers/hints 完全一致（强断言）", () => {
    expect(v1Questions).toHaveLength(8);
    v1Questions.forEach((v1, i) => {
      const v2 = v2Questions[i];
      expect(v2, `第 ${i + 1} 题应存在`).toBeDefined();
      if (v2 === undefined) return;
      expect(v2.id, `第 ${i + 1} 题 id`).toBe(v1.id);
      expect(v2.type, `第 ${i + 1} 题题型`).toBe(v1.type);
      expect(v2.difficulty, `第 ${i + 1} 题难度`).toBe(v1.difficulty);
      expect(v2.knowledge, `第 ${i + 1} 题考点`).toEqual(v1.knowledge);
      expect(v2.answers, `第 ${i + 1} 题答案`).toEqual(v1.answers);
      expect(v2.hints, `第 ${i + 1} 题提示`).toEqual(v1.hints);
    });
  });

  it("逐题：选项语义一致（v1 key+答案下标 ↔ v2 correct 标记）", () => {
    const v1Choice = v1Questions[2];
    const v2Choice = v2Questions[2];
    expect(v1Choice?.type).toBe("choice");
    expect(v2Choice?.options?.map((o) => o.text)).toEqual(
      v1Choice?.options?.map((o) => o.text),
    );
    expect(v2Choice?.options?.map((o) => o.correct)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("逐题：solutionMd 完全一致（details 剔除 summary 后内容）", () => {
    v1Questions.forEach((v1, i) => {
      const v2 = v2Questions[i];
      expect(v2?.solutionMd ?? "", `第 ${i + 1} 题详解`).toBe(
        v1.solutionMd ?? "",
      );
    });
  });

  it("逐题：stemMd 形态变换精确断言（人工推演）", () => {
    const stem = (id: string): string | undefined =>
      v1Questions.find((q) => q.id === id)?.stemMd;
    const v2Stem = (i: number): string | undefined => v2Questions[i]?.stemMd;

    // 题 1 判断：v1 stem 末尾追加 [[正确]]
    expect(v2Stem(0)).toBe(`${stem("练习四-1")} [[正确]]`);
    // 题 2 填空：两个 ____ 依次替换为 [[4]]、[[-7]]
    expect(v2Stem(1)).toBe("填空：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。");
    // 题 3 选择：题干 + 空行 + 任务列表（B 项 [x]）
    expect(v2Stem(2)).toBe(
      [
        "计算 $-3-(-7)$ 的结果是（　）。",
        "",
        "- [ ] $-10$",
        "- [x] $4$",
        "- [ ] $-4$",
        "- [ ] $10$",
      ].join("\n"),
    );
    // 题 4/5/7/8 手写题：题干原样保留
    expect(v2Stem(3)).toBe(stem("练习四-4"));
    expect(v2Stem(4)).toBe(stem("练习四-5"));
    expect(v2Stem(6)).toBe(stem("练习四-7"));
    expect(v2Stem(7)).toBe(stem("练习四-8"));
    // 题 6 填空：____ 替换为 [[6]]
    expect(v2Stem(5)).toBe("填空：$|-6|=$ [[6]]。");
  });

  it("sourceMd：v1 解析存 v1 原文片段，往返后是 v2 形态（取舍：不参与一致性比较）", () => {
    expect(v1Questions[0]?.sourceMd).toContain("#### 题 1（★）");
    expect(v2Questions[0]?.sourceMd).toContain("::::question");
  });
});

describe("v1ToV2：边界转换（保证 lint 0 error 的降级规则）", () => {
  it("填空无答案 → 降级为 solve（教师批改），题干 ____ 保留，lint 0 error", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】填空",
      "填空：$1+1=$ ____。",
      "",
    ].join("\n");
    const text = v1ToV2(md);
    const result = lintDocument(text);
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.parsed.units[0]?.questions[0]?.type).toBe("solve");
    expect(result.parsed.units[0]?.questions[0]?.stemMd).toContain("____");
  });

  it("判断无答案 → 降级为 solve，不生成 [[正确]]/[[错误]] 标记，lint 0 error", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】判断",
      "判断：这句话对吗？",
      "",
    ].join("\n");
    const result = lintDocument(v1ToV2(md));
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.parsed.units[0]?.questions[0]?.type).toBe("solve");
  });

  it("选择无答案 → 降级为 solve，选项转普通列表，lint 0 error", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】选择",
      "选一个：",
      "A. 甲",
      "B. 乙",
      "",
    ].join("\n");
    const text = v1ToV2(md);
    const result = lintDocument(text);
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.parsed.units[0]?.questions[0]?.type).toBe("solve");
    expect(result.parsed.units[0]?.questions[0]?.stemMd).toContain("- 甲");
  });

  it("多正确项选择题 → type=multi 输出，lint 0 error", () => {
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
    const result = lintDocument(v1ToV2(md));
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.parsed.units[0]?.questions[0]?.answers).toEqual({
      kind: "multi",
      indexes: [0, 2],
    });
  });

  it("填空答案多于空位：多余答案以 [[…]] 追加题干末尾，不丢判分信息", () => {
    const md = [
      "## 练习",
      "",
      "#### 题 1（★）",
      "【题型】填空",
      "填空：$1+1=$ ____。",
      "",
      "<!-- ANSWER: 2;; 3 -->",
      "",
    ].join("\n");
    const result = lintDocument(v1ToV2(md));
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(result.parsed.units[0]?.questions[0]?.answers).toEqual({
      kind: "fill",
      blanks: [["2"], ["3"]],
    });
    expect(result.parsed.units[0]?.questions[0]?.stemMd).toContain("[[3]]");
  });

  it("无题文档：输出仅 frontmatter，仍为合法 v2（0 error）", () => {
    const result = lintDocument(v1ToV2("# 空文档\n"));
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("v1ToV2Units：多单元文档按单元拆分", () => {
  const multi = [
    "## 练习一 加法",
    "<!-- UNIT: 练习一|第1讲|加法 -->",
    "",
    "#### 题 1（★）",
    "【题型】填空",
    "填空：$1+1=$ ____。",
    "",
    "<!-- ANSWER: 2 -->",
    "",
    "## 练习二 减法",
    "",
    "#### 题 1（★）",
    "【题型】填空",
    "填空：$3-1=$ ____。",
    "",
    "<!-- ANSWER: 2 -->",
    "",
  ].join("\n");

  it("每单元一个合法 v2 文档，各带自己的 frontmatter 与题目", () => {
    const docs = v1ToV2Units(multi);
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      const result = lintDocument(doc);
      expect(result.issues, doc).toEqual([]);
    }
    expect(docs[0]).toContain('unit: "练习一"');
    expect(docs[1]).toContain('unit: "练习二 减法"');
    expect(docs[0]).toContain('id="练习一-1"');
    expect(docs[1]).toContain('id="练习二 减法-1"');
  });

  it("v1ToV2 对多单元文档：合并为单文档（frontmatter 取第一单元，题目显式 id 保持不冲突）", () => {
    const doc = v1ToV2(multi);
    const result = lintDocument(doc);
    expect(result.issues).toEqual([]);
    const questions = result.parsed.units[0]?.questions ?? [];
    expect(questions.map((q) => q.id)).toEqual(["练习一-1", "练习二 减法-1"]);
    expect(result.parsed.frontmatter?.unit).toBe("练习一");
  });
});

describe("v1ToV2：健壮性（纯函数不抛异常）", () => {
  const hostileInputs = [
    "",
    "\n\n\n",
    "\u0000\uFFFF乱码???<script>alert(1)</script>",
    "####",
    "<!-- ANSWER:",
    "<details>",
    sample.slice(0, Math.floor(sample.length / 2)),
  ];

  it.each(hostileInputs.map((text, i) => [`输入 #${i}`, text] as const))(
    "不抛异常且输出可被 v2 lint：%s",
    (_name, text) => {
      expect(() => v1ToV2(text)).not.toThrow();
      expect(() => lintDocument(v1ToV2(text))).not.toThrow();
    },
  );

  it("快照：样例转换输出稳定", async () => {
    await expect(converted).toMatchFileSnapshot(
      fileURLToPath(new URL("./__snapshots__/v1-to-v2.snap", import.meta.url)),
    );
  });
});

describe("v1ToV2：全套往返一致性（题型无关的通用断言）", () => {
  /** 对任意 v1 文档：合法转换后 id/type/answers/knowledge/solutionMd 逐题一致 */
  const roundTripCases: ReadonlyArray<readonly [string, string]> = [
    [
      "多空填空",
      "## 练习\n\n#### 题 1（★）\n【题型】填空\n甲____乙____。\n\n<!-- ANSWER: 1;; 2 -->\n",
    ],
    [
      "选择",
      "## 练习\n\n#### 题 1（★）\n【题型】选择\n选：\nA. 甲\nB. 乙\n\n<!-- ANSWER: A -->\n",
    ],
    [
      "判断",
      "## 练习\n\n#### 题 1（★）\n【题型】判断\n判断。\n\n<!-- ANSWER: 错误 -->\n",
    ],
    [
      "带详解",
      "## 练习\n\n#### 题 1（★）\n【题型】计算\n计算。\n\n<!-- ANSWER: 8 -->\n\n<details>\n<summary>详解</summary>\n\n步骤一。\n\n</details>\n",
    ],
  ];

  it.each(roundTripCases)("往返一致：%s", (_name, md) => {
    const v1 = parseV1(md);
    const result = lintDocument(v1ToV2(md));
    expect(result.issues).toEqual([]);
    const v1Q = v1.units[0]?.questions ?? [];
    const v2Q = result.parsed.units[0]?.questions ?? [];
    expect(v2Q).toHaveLength(v1Q.length);
    v1Q.forEach((q: Question, i: number) => {
      expect(v2Q[i]?.id).toBe(q.id);
      expect(v2Q[i]?.type).toBe(q.type);
      expect(v2Q[i]?.difficulty).toBe(q.difficulty);
      expect(v2Q[i]?.knowledge).toEqual(q.knowledge);
      expect(v2Q[i]?.answers).toEqual(q.answers);
      expect(v2Q[i]?.solutionMd ?? "").toBe(q.solutionMd ?? "");
    });
  });
});
