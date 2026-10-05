import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ListItem } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse.ts";
import {
  displayStemMd,
  stripOptionListMd,
  studentStemMd,
} from "./public-stem.ts";
import { processor } from "./shared.ts";

/**
 * 学生端题干投影单测（2026-10 选项内嵌泄露修复）：
 * - stripOptionListMd：按 AST 定位 GFM 任务列表项（与解析器 scanStem 同一谓词：
 *   listItem.checked 为布尔）整项剥除——含多行选项的续行，杜绝逐行正则的孤儿行；
 * - studentStemMd：学生端题干唯一入口 = 剥选项（options 另行下发时）+ [[答案]] 脱敏，
 *   投影后题干不得携带任何可判定答案的标记（[x] / 非空 [[…]]）；
 * - samples 语料属性测试：以解析器为 oracle——投影结果重新解析后提取不到任何答案，
 *   新的「秘密嵌进正文」语法一旦被解析器识别即自动纳入本测试守卫。
 */

/** 与解析器 scanStem 同口径：listItem.checked 为布尔即 GFM 任务列表项（选择题选项） */
function isTaskListItem(node: unknown): node is ListItem {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "listItem" &&
    typeof (node as { checked?: unknown }).checked === "boolean"
  );
}

/** 非空填空/判断标记（math/code 子树外才算泄露，与 publicStemMd 同语义） */
const NON_EMPTY_MARKER_RE = /\[\[[^[\]]+\]\]/;

describe("stripOptionListMd（题干选项任务列表结构剥离）", () => {
  it("剥掉任务列表项整行（含正确项 [x]），保留题干与其余内容", () => {
    const stem =
      "一个算法应该具有（）等重要特性。\n\n- [ ] 可维护性\n- [x] 可行性与有穷性\n- [ ] 确定性\n- [ ] 可读性";
    expect(stripOptionListMd(stem)).toBe("一个算法应该具有（）等重要特性。");
  });

  it("多行选项的续行一并剥除（AST 按行区间定位，非逐行正则）", () => {
    const stem =
      "阅读代码：\n\n```c\nint m = 0;\n```\n\n- [x] 复杂度为 $O(n)$\n  当 n 翻倍时\n  运行时间随之翻倍\n- [ ] 复杂度为 $O(1)$";
    expect(stripOptionListMd(stem)).toBe("阅读代码：\n\n```c\nint m = 0;\n```");
  });

  it("有序列表写法 1. [ ] / 2. [x] 同样剥除", () => {
    expect(
      stripOptionListMd("下列正确的是（　）\n\n1. [ ] 甲\n2. [x] 乙"),
    ).toBe("下列正确的是（　）");
  });

  it("选项列表与后续段落之间的空行整理为单个分隔（不残留连续空行）", () => {
    const stem = "题干段。\n\n- [ ] 甲\n- [x] 乙\n\n再说明一句。";
    expect(stripOptionListMd(stem)).toBe("题干段。\n\n再说明一句。");
  });

  it("代码块内的 - [x] 不是任务列表项，不剥", () => {
    const stem = "补全代码：\n\n```\n- [x] 伪代码记号\n```\n\n如上。";
    expect(stripOptionListMd(stem)).toBe(stem);
  });

  it("转义写法与普通方括号列表不是任务列表项，不剥", () => {
    const stem = "已知：\n\n\\- \\[x\\] 转义写法\n\n- [备注] 普通列表项";
    expect(stripOptionListMd(stem)).toBe(stem);
  });

  it("无任务列表时原样返回同一字符串", () => {
    const stem = "计算 $[1,2]$ 的长度。\n\n已知：\n- 甲\n- 乙";
    expect(stripOptionListMd(stem)).toBe(stem);
  });
});

describe("studentStemMd（学生端题干唯一投影：剥选项 + 标记脱敏）", () => {
  it("choice：选项列表剥除、[[答案]] 脱敏，题干不含任何可判定答案的标记", () => {
    const projected = studentStemMd({
      stemMd: "若 $a=2$，则 $a^2=$ [[4]]，正确说法是（）\n\n- [ ] 甲\n- [x] 乙",
      options: [{ text: "甲" }, { text: "乙" }],
    });
    expect(projected).toBe("若 $a=2$，则 $a^2=$ [[]]，正确说法是（）");
  });

  it("fill（无 options）：题干完整保留、标记脱敏", () => {
    const stemMd = "计算：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。";
    expect(studentStemMd({ stemMd })).toBe(
      "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。",
    );
  });

  it("solve 题干中的合法任务清单（无 options 另行下发）不剥", () => {
    const stemMd = "按步骤排查：\n\n- [ ] 第一步\n- [ ] 第二步\n\n写出结论。";
    expect(studentStemMd({ stemMd })).toBe(stemMd);
  });
});

describe("displayStemMd（显示侧题干：选项另行渲染时剥内嵌列表）", () => {
  it("有 options 剥列表但不脱敏标记（[[答案]] 由 remark-blank 渲染为空框）", () => {
    expect(
      displayStemMd({
        stemMd: "计算 [[4]] 后选择（）\n\n- [ ] 甲\n- [x] 乙",
        options: [{ text: "甲" }, { text: "乙" }],
      }),
    ).toBe("计算 [[4]] 后选择（）");
  });

  it("无 options 原样返回", () => {
    const stemMd = "已知：\n- 甲\n- 乙";
    expect(displayStemMd({ stemMd })).toBe(stemMd);
  });
});

describe("samples 语料属性测试（解析器为 oracle：投影后提取不到任何答案）", () => {
  const corpusRoot = fileURLToPath(
    new URL("../../../../samples/", import.meta.url),
  );
  const files: Array<{ name: string; md: string }> = [];
  for (const dir of ["v2", "lint"]) {
    for (const entry of readdirSync(join(corpusRoot, dir))) {
      if (!entry.endsWith(".md")) continue;
      files.push({
        name: `${dir}/${entry}`,
        md: readFileSync(join(corpusRoot, dir, entry), "utf8"),
      });
    }
  }

  it("语料非空（练习/混合/讲义 + lint 反例均被属性测试覆盖）", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it("每道题投影后：无任务列表项残留、无非空 [[…]] 标记泄露", () => {
    const violations: string[] = [];
    for (const { name, md } of files) {
      const parsed = parseDocument(md);
      for (const unit of parsed.units) {
        for (const question of unit.questions) {
          const projected = studentStemMd(question);
          const tree = processor.parse(projected);
          visit(tree, (node) => {
            if (
              node.type === "math" ||
              node.type === "inlineMath" ||
              node.type === "code" ||
              node.type === "inlineCode"
            ) {
              return SKIP; // 公式/代码内的 [[…]] 是记号，与解析器/publicStemMd 同语义
            }
            if (isTaskListItem(node)) {
              violations.push(`${name} ${question.id}: 任务列表项残留`);
            }
            if (node.type === "text") {
              const value = (node as { value?: unknown }).value;
              if (
                typeof value === "string" &&
                NON_EMPTY_MARKER_RE.test(value)
              ) {
                violations.push(
                  `${name} ${question.id}: 非空标记泄露 ${value}`,
                );
              }
            }
            return undefined;
          });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
