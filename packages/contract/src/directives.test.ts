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
  directiveLocationSchema,
  exampleDirective,
  foldDirective,
  getDirective,
  graphDirective,
  groupDirective,
  hintDirective,
  imageDirective,
  itemDirective,
  listDirectives,
  markDirective,
  materialDirective,
  optionDirective,
  optionsDirective,
  questionDirective,
  refDirective,
  type RegisteredDirective,
  segDirective,
  solutionDirective,
  stepDirective,
  stepsDirective,
  tipDirective,
  variantDirective,
  warningDirective,
} from "./directives";

/**
 * 首发指令（§5.1.1(5) 表）清单与各指令契约的回归测试。
 * 注意：本文件不断言注册表长度为固定值之外的机制行为（临时注册等在
 * directives.registry.test.ts 中，依赖 vitest 文件级模块隔离）。
 */

/**
 * §5.1.1(5) 首发指令全集（题目结构 5 / 讲义互动 4 / 版式强调 6 / 媒体 2）
 * + TT-06 材料与题组批次（§5.4.1：material/group/seg/ref/options/option/item/variant）。
 */
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
  // 材料与题组（TT-06/QM-04，§5.4.1 新增批次）
  "material",
  "group",
  "seg",
  "ref",
  "options",
  "option",
  "item",
  "variant",
] as const;

describe("首发清单：§5.1.1(5) 全部指令已登记", () => {
  it("数量恰为 25（首发 17 + TT-06 批次 8），名称与注册顺序一致", () => {
    const names = listDirectives().map((d) => d.name);
    expect(names).toEqual([...FIRST_RELEASE_DIRECTIVES]);
    expect(names).toHaveLength(25);
  });

  it("每个首发指令按名可查（2.0 首发 / 2.1 TT-06 批次），描述/样例非空", () => {
    const SINCE_21 = new Set([
      "material",
      "group",
      "seg",
      "ref",
      "options",
      "option",
      "item",
      "variant",
    ]);
    for (const name of FIRST_RELEASE_DIRECTIVES) {
      const d = getDirective(name);
      expect(d, `指令 ${name} 应已注册`).toBeDefined();
      expect(d?.since).toBe(SINCE_21.has(name) ? "2.1" : "2.0");
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

describe("image：新增可选属性 alt（媒体管线，只增不改合规）", () => {
  it("alt 可选：不写时解析结果不含 alt 键（缺省「图片」由渲染端兜底）", () => {
    const parsed = imageDirective.attrs.parse({
      src: "blobs/media/9af3.png",
    });
    expect(parsed.src).toBe("blobs/media/9af3.png");
    expect(parsed).not.toHaveProperty("alt");
  });

  it("alt 写非空值即通过并保留；空串 / 无值简写被拒", () => {
    expect(
      imageDirective.attrs.safeParse({
        src: "blobs/fig-1.png",
        alt: "数轴示意图",
      }).success,
    ).toBe(true);
    expect(
      imageDirective.attrs.parse({ src: "blobs/fig-1.png", alt: "数轴" }).alt,
    ).toBe("数轴");
    expect(
      imageDirective.attrs.safeParse({ src: "blobs/fig-1.png", alt: "" })
        .success,
    ).toBe(false);
  });

  it("example 与 attrDocs 自洽：示例含 blobs/media/ 路径且用到 alt", () => {
    expect(imageDirective.example).toContain("blobs/media/");
    expect(imageDirective.example).toContain("alt=");
    expect(imageDirective.attrDocs?.src).toContain("blobs/media/");
    expect(imageDirective.attrDocs?.alt).toBeDefined();
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
      graphDirective,
    ]) {
      expect([...d.allowedIn].sort()).toEqual(["lecture", "question"]);
    }
    // image 自 TT-06 起 additionally 允许材料内（§5.4.1，材料内图片同规则）
    expect([...imageDirective.allowedIn].sort()).toEqual([
      "lecture",
      "material",
      "question",
    ]);
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

describe("能力标注与方案 §4.3 标注表一致（T7.4）", () => {
  it("blank = fill 输入 + snapshot 证据（判分取所在题型，指令上不标 validation）", () => {
    expect(blankDirective.capability).toEqual({
      interaction: { inputType: "fill" },
      evidence: { format: "snapshot" },
    });
  });

  it("hint / fold / solution = none + snapshot（展开/收起遥测，none 无作答输入）", () => {
    const foldLike = {
      interaction: { inputType: "none" },
      evidence: { format: "snapshot" },
    };
    expect(hintDirective.capability).toEqual(foldLike);
    expect(foldDirective.capability).toEqual(foldLike);
    expect(solutionDirective.capability).toEqual(foldLike);
  });

  it("steps = steps 输入 + snapshot 证据；不带 validation（不做部分判分）", () => {
    expect(stepsDirective.capability).toEqual({
      interaction: { inputType: "steps" },
      evidence: { format: "snapshot" },
    });
    expect(stepsDirective.capability?.validation).toBeUndefined();
  });

  it("question/answer/example/step 与纯展示指令省略整个 capability（行为不变）", () => {
    for (const d of [
      questionDirective,
      answerDirective,
      exampleDirective,
      stepDirective,
      tipDirective,
      warningDirective,
      boxDirective,
      columnsDirective,
      colDirective,
      markDirective,
      imageDirective,
      graphDirective,
    ]) {
      expect(d.capability, `${d.name} 应省略整个 capability`).toBeUndefined();
    }
  });

  it("全部已注册指令无 partial 声明（词表保留但本阶段无实现无声明）", () => {
    for (const d of listDirectives()) {
      expect(d.capability?.validation?.shape, `${d.name}`).not.toBe("partial");
    }
  });
});

describe("TT-06 材料与题组指令（§5.4.1 注册草案）", () => {
  it("位置枚举含 material/group/options 三个新语境", () => {
    for (const loc of ["material", "group", "options"] as const) {
      expect(directiveLocationSchema.safeParse(loc).success).toBe(true);
    }
    expect(directiveLocationSchema.safeParse("hallway").success).toBe(false);
  });

  it("material/group：文档顶层容器；seg 限材料内；option 限选项池内", () => {
    expect(materialDirective.allowedIn).toEqual(["document"]);
    expect(groupDirective.allowedIn).toEqual(["document"]);
    expect(segDirective.allowedIn).toEqual(["material"]);
    expect(optionDirective.allowedIn).toEqual(["options"]);
    expect(optionsDirective.allowedIn).toEqual(["question"]);
    expect(itemDirective.allowedIn).toEqual(["question"]);
    expect(variantDirective.allowedIn).toEqual(["question"]);
    expect(refDirective.allowedIn).toEqual(["group", "question"]);
  });

  it("image 的 allowedIn 含 material（材料内图片同规则，§5.4.1）", () => {
    expect(imageDirective.allowedIn).toContain("material");
    expect(imageDirective.allowedIn).toContain("lecture");
    expect(imageDirective.allowedIn).toContain("question");
  });

  it("ref：material 与 question 恰写其一（§5.2.1 两种引用形态，语料为准）", () => {
    // 材料引用：material + 可选 segs/slot/slots
    expect(
      refDirective.attrs.safeParse({ material: "mat-1" }).success,
    ).toBe(true);
    expect(
      refDirective.attrs.safeParse({
        material: "mat-1",
        segs: "seg-1..seg-2",
        slot: "slot-3",
      }).success,
    ).toBe(true);
    // 子题引用：question（组内子题引用，§5.2.1）
    expect(refDirective.attrs.safeParse({ question: "q-1" }).success).toBe(
      true,
    );
    // 两者都缺 / 两者都写：拒绝
    expect(refDirective.attrs.safeParse({}).success).toBe(false);
    expect(
      refDirective.attrs.safeParse({ material: "mat-1", question: "q-1" })
        .success,
    ).toBe(false);
    // 未知属性拒绝（strict）
    expect(
      refDirective.attrs.safeParse({ material: "mat-1", seg: "seg-1" })
        .success,
    ).toBe(false);
  });

  it("bool 属性以字符串 true/false 书写并解析为布尔（§5.4：mdast 属性恒为字符串）", () => {
    // options.allow-repeat（输出键保留 DSL 属性名，allowRepeat 映射在解析层）
    expect(optionsDirective.attrs.parse({})).toEqual({
      "allow-repeat": false,
    });
    expect(optionsDirective.attrs.parse({ "allow-repeat": "true" })).toEqual({
      "allow-repeat": true,
    });
    expect(optionsDirective.attrs.parse({ "allow-repeat": "false" })).toEqual({
      "allow-repeat": false,
    });
    expect(
      optionsDirective.attrs.safeParse({ "allow-repeat": "yes" }).success,
    ).toBe(false);
    // item.fixed / item.distractor
    expect(itemDirective.attrs.parse({})).toEqual({
      fixed: false,
      distractor: false,
    });
    expect(
      itemDirective.attrs.parse({ fixed: "true", distractor: "true" }),
    ).toEqual({ fixed: true, distractor: true });
  });

  it("question 新增 word-min/word-max：字符串数字 coerce、正整数、可选", () => {
    expect(
      questionDirective.attrs.parse({ type: "response", "word-min": "150" }),
    ).toMatchObject({ type: "response", "word-min": 150 });
    expect(
      questionDirective.attrs.parse({ type: "response", "word-max": "1000" }),
    ).toMatchObject({ type: "response", "word-max": 1000 });
    expect(
      questionDirective.attrs.safeParse({ type: "response", "word-min": "0" })
        .success,
    ).toBe(false);
    expect(
      questionDirective.attrs.parse({ type: "response" })["word-min"],
    ).toBeUndefined();
    // 旧文档键集不受影响：不带新属性照常解析
    expect(
      questionDirective.attrs.parse({ type: "fill", difficulty: "3" }),
    ).toMatchObject({ type: "fill", difficulty: 3 });
  });
});
