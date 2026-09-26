import { describe, expect, it } from "vitest";
import { z } from "zod";
import { questionTypeSchema } from "./content";
import {
  answerDirective,
  blankDirective,
  boxDirective,
  colDirective,
  columnsDirective,
  defineDirective,
  exampleDirective,
  foldDirective,
  getDirective,
  graphDirective,
  hintDirective,
  imageDirective,
  listDirectives,
  markDirective,
  questionDirective,
  type RegisteredDirective,
  solutionDirective,
  stepDirective,
  stepsDirective,
  tipDirective,
  warningDirective,
} from "./directives";

/**
 * 首发指令（§5.1.1(5) 表）清单与各指令契约的回归测试。
 * 注意：本文件不断言注册表长度为固定值之外的机制行为（临时注册等在
 * directives.registry.test.ts 中，依赖 vitest 文件级模块隔离）。
 */

/** §5.1.1(5) 首发指令全集，按表中类别顺序（题目结构 5 / 讲义互动 4 / 版式强调 6 / 媒体 2） */
const FIRST_RELEASE_DIRECTIVES = [
  // 题目结构
  "question",
  "hint",
  "answer",
  "solution",
  "blank",
  // 讲义互动
  "example",
  "steps",
  "step",
  "fold",
  // 版式与强调
  "tip",
  "warning",
  "box",
  "columns",
  "col",
  "mark",
  // 媒体
  "image",
  "graph",
] as const;

describe("首发清单：§5.1.1(5) 全部指令已登记", () => {
  it("数量恰为 17，名称与顺序与架构文档一致", () => {
    const names = listDirectives().map((d) => d.name);
    expect(names).toEqual([...FIRST_RELEASE_DIRECTIVES]);
    expect(names).toHaveLength(17);
  });

  it("每个首发指令按名可查，since 均为 2.0，描述/样例非空", () => {
    for (const name of FIRST_RELEASE_DIRECTIVES) {
      const d = getDirective(name);
      expect(d, `指令 ${name} 应已注册`).toBeDefined();
      expect(d?.since).toBe("2.0");
      expect(d?.description.length ?? 0).toBeGreaterThan(4);
      expect(d?.example.length ?? 0).toBeGreaterThan(0);
      expect(d?.allowedIn.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("首发不登记任何别名（2.0 无历史改名）", () => {
    for (const d of listDirectives()) {
      expect(d.aliases ?? []).toEqual([]);
    }
  });

  it("重复登记首发指令名被唯一性检查拒绝", () => {
    expect(() =>
      defineDirective({
        name: "question",
        kind: "container",
        since: "2.0",
        allowedIn: ["document"],
        attrs: z.strictObject({}),
        description: "重复注册试验",
        example: ":::question\n内容\n:::",
      }),
    ).toThrow(/冲突/);
  });
});

describe("example 与 kind/syntax 自洽（独立于注册期校验的回归断言）", () => {
  it("container：首行 :::{3,}名称{属性}、末行 :::；嵌套示例外层多冒号亦匹配", () => {
    for (const d of listDirectives()) {
      if (d.kind !== "container") continue;
      const lines = d.example
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(
        new RegExp(`^:{3,}${d.name}(\\{.*\\})?$`).test(lines[0] ?? ""),
        `${d.name} 的 example 首行`,
      ).toBe(true);
      expect(/^:{3,}$/.test(lines[lines.length - 1] ?? "")).toBe(true);
    }
  });

  it("leaf：example 为 ::名称[文字]{属性} 单行", () => {
    for (const d of listDirectives()) {
      if (d.kind !== "leaf") continue;
      expect(
        new RegExp(`^::${d.name}(\\[[^\\]]*\\])?(\\{.*\\})?$`).test(
          d.example.trim(),
        ),
        `${d.name} 的 example`,
      ).toBe(true);
    }
  });

  it("text：example 含 :名称[ 行内形态", () => {
    for (const d of listDirectives()) {
      if (d.kind !== "text" || d.syntax !== undefined) continue;
      expect(d.example.includes(`:${d.name}[`)).toBe(true);
    }
  });

  it("blank 是 [[…]] 语法糖：example 含填空标记且不出现指令名写法", () => {
    expect(blankDirective.syntax).toBe("[[答案]]");
    expect(blankDirective.example).toContain("[[");
    expect(blankDirective.example).toContain("]]");
    expect(blankDirective.example).not.toMatch(/:blank/);
  });
});

describe("question：与 content.ts 契约对齐", () => {
  it("type 枚举与 questionTypeSchema 同源一致（契约优先，禁止重复定义）", () => {
    const attrType = questionDirective.attrs.shape.type;
    expect(attrType.options).toEqual(questionTypeSchema.options);
    // 双向抽查：content 拒绝的值这里也拒绝
    expect(questionDirective.attrs.safeParse({ type: "essay" }).success).toBe(
      false,
    );
    expect(questionTypeSchema.safeParse("essay").success).toBe(false);
  });

  it("difficulty 取值域与 content.ts 一致（1–5 整数），缺省为 2", () => {
    // remark-directive 产出的是字符串，schema 需接受 "2" 并转为数字
    const parsed = questionDirective.attrs.parse({
      type: "fill",
      difficulty: "2",
    });
    expect(parsed.difficulty).toBe(2);
    // 缺省 2
    expect(questionDirective.attrs.parse({ type: "fill" }).difficulty).toBe(2);
    // 越界 / 非整数 / 非数字
    for (const bad of [0, 6, 2.5, "9", "abc", ""]) {
      expect(
        questionDirective.attrs.safeParse({ type: "fill", difficulty: bad })
          .success,
        `difficulty=${String(bad)}`,
      ).toBe(false);
    }
  });

  it("knowledge/id 可选；id 与 class 由 {#id .样式类} 简写进入属性", () => {
    const parsed = questionDirective.attrs.parse({
      type: "solve",
      id: "p4-q7",
      class: "highlight",
      knowledge: "有理数混合运算",
    });
    expect(parsed.id).toBe("p4-q7");
    expect(parsed.class).toBe("highlight");
    expect(parsed.knowledge).toBe("有理数混合运算");
    const minimal = questionDirective.attrs.parse({ type: "solve" });
    expect(minimal).not.toHaveProperty("id");
    expect(minimal).not.toHaveProperty("knowledge");
  });
});

describe("attrs 缺省值生效（验收第 2 条）", () => {
  it("mark.color 缺省 yellow；step.title 缺省空串；fold.title 缺省「详情」", () => {
    expect(markDirective.attrs.parse({}).color).toBe("yellow");
    expect(stepDirective.attrs.parse({}).title).toBe("");
    expect(foldDirective.attrs.parse({}).title).toBe("详情");
  });

  it("空属性指令（hint/solution/answer/columns）解析为仅含底座可选属性", () => {
    const parsed = hintDirective.attrs.parse({});
    expect(parsed).toEqual({});
  });
});

describe("非法属性校验失败（验收第 3 条）", () => {
  it("question：未知属性名（拼写错误）被 strict 拒绝，而不是静默套缺省值", () => {
    expect(
      questionDirective.attrs.safeParse({ type: "fill", difculty: 2 }).success,
    ).toBe(false);
  });

  it("mark：color 只接受登记的枚举值", () => {
    expect(markDirective.attrs.safeParse({ color: "red" }).success).toBe(true);
    expect(markDirective.attrs.safeParse({ color: "pink" }).success).toBe(
      false,
    );
  });

  it("image.src 必填；graph.fn 必填", () => {
    expect(imageDirective.attrs.safeParse({}).success).toBe(false);
    expect(
      imageDirective.attrs.safeParse({ src: "blobs/fig-1.png" }).success,
    ).toBe(true);
    expect(graphDirective.attrs.safeParse({}).success).toBe(false);
    expect(graphDirective.attrs.safeParse({ fn: "x^2" }).success).toBe(true);
  });

  it("box：.样式类 简写进入 class 属性，可与 title 同用", () => {
    const parsed = boxDirective.attrs.parse({
      class: "warning",
      title: "易错点",
    });
    expect(parsed).toEqual({ class: "warning", title: "易错点" });
  });
});

describe("allowedIn：与 §5.1 规则要点表一致", () => {
  it("question 只在文档顶层；hint/solution 在题目与讲义；answer 仅题目内", () => {
    expect(questionDirective.allowedIn).toEqual(["document"]);
    expect(hintDirective.allowedIn).toEqual(["question", "lecture"]);
    expect(solutionDirective.allowedIn).toEqual(["question", "lecture"]);
    expect(answerDirective.allowedIn).toEqual(["question"]);
  });

  it("step 仅在 steps 内；col 仅在 columns 内；讲义互动指令限讲义", () => {
    expect(stepDirective.allowedIn).toEqual(["steps"]);
    expect(colDirective.allowedIn).toEqual(["columns"]);
    expect(exampleDirective.allowedIn).toEqual(["lecture"]);
    expect(stepsDirective.allowedIn).toEqual(["lecture"]);
    expect(foldDirective.allowedIn).toEqual(["lecture"]);
  });

  it("版式/媒体指令讲义与题目内均可用", () => {
    for (const d of [
      tipDirective,
      warningDirective,
      boxDirective,
      columnsDirective,
      markDirective,
      imageDirective,
      graphDirective,
    ]) {
      expect([...d.allowedIn].sort()).toEqual(["lecture", "question"]);
    }
  });

  it("blank 仅在 question 语境（题干中的 [[…]]）", () => {
    expect(blankDirective.allowedIn).toEqual(["question"]);
    expect(blankDirective.kind).toBe("text");
  });
});

describe("attrDocs：gen:spec 属性表数据源（T1.7）", () => {
  /** attrs 业务属性键（不含 id/class 通用底座，二者的说明统一写在规范总则） */
  function businessAttrKeys(d: RegisteredDirective): string[] {
    const shape = (
      d.attrs as unknown as {
        readonly shape?: Readonly<Record<string, unknown>>;
      }
    ).shape;
    return Object.keys(shape ?? {}).filter(
      (key) => key !== "id" && key !== "class",
    );
  }

  it("每个首发指令的全部业务属性都有 attrDocs 说明（缺说明即测试失败）", () => {
    for (const d of listDirectives()) {
      const docs = d.attrDocs ?? {};
      for (const key of businessAttrKeys(d)) {
        expect(
          (docs as Record<string, string | undefined>)[key]?.length ?? 0,
          `${d.name} 的属性 ${key} 缺少 attrDocs 说明`,
        ).toBeGreaterThan(3);
      }
    }
  });

  it("attrDocs 不含多余键（每个说明都对应真实属性）", () => {
    for (const d of listDirectives()) {
      const shape = (
        d.attrs as unknown as {
          readonly shape?: Readonly<Record<string, unknown>>;
        }
      ).shape;
      const keys = new Set(Object.keys(shape ?? {}));
      for (const key of Object.keys(d.attrDocs ?? {})) {
        expect(
          keys.has(key),
          `${d.name} 的 attrDocs 键 ${key} 不是真实属性`,
        ).toBe(true);
      }
    }
  });
});
