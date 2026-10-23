import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

/**
 * I16 全量 AST 守护（UA-05，方案 §11.2 / 决策记录 §6.3）：
 * 扫 apps/web/src 与 apps/server/src 的生产源码（排除 *.test.*、test/、
 * __tests__/、fixtures、生成产物、.d.ts），用语法树识别**答案 kind / 题型
 * 字面量判别分支**——if / 三元里的比较表达式与 switch 的 case 子句。发现
 * 白名单之外的分支即测试失败：调度边界以外不得新增未授权分支（I16）。
 *
 * 解析器说明（偏离 §11.2 字面建议的原因）：仓库 devDependency 的 typescript
 * 已是 7.0.2 原生二进制包装（lib/ 只有 tsc.js 启动器，无 ts.createSourceFile
 * JS API）；改用 apps/web 既有 devDependency vite 导出的 parseAst（rollup/oxc
 * ESTree 语法树，lang: ts/tsx），同为「仓库已有 TypeScript 工具、零新依赖」。
 *
 * 检测形态（AST 节点级，非裸文本）：
 * - BinaryExpression（=== / !== / == / !=）：一侧为 kind 字面量
 *   {judge|choice|multi|fill|final|solve|apply|find-error}，另一侧为
 *   `.kind` / `.type` 属性访问（含可选链 a?.kind 与计算访问 x["kind"]）
 *   或 kind/type（含 camelCase 别名 answerKind、questionType——覆盖解构
 *   局部变量与中央分发局部判别式）。
 * - SwitchStatement：判别式同上，且 case 测试是 kind 字面量。
 *   —— 其他领域的 kind/type 判别（笔迹工具 pen/eraser、讲练块 md/question、
 *   内容操作 createUnit、事件 question_focus 等）字面量不在集合内，不误伤；
 *   字符串与注释里的伪代码不产生 AST 节点，天然免疫（自检用例锁定）。
 *
 * 守护覆盖不了的局限（仍须人工审查，§11.2）：动态比较（变量间比较、
 * 非字面量判别式）、别名（改名后不叫 kind/type 的局部变量、经函数转发的
 * 判别）、映射索引与集合成员（record[kind]、HANDWRITTEN_TYPES.has(type)）、
 * 数值判别式、字符串拼接构造；三类残余局限（审查补记）：同文件等数置换
 * （同文件删一处合法片段、增一处同文本有害片段，多重集合计数不变可
 * 绕过——由类型系统与对话框态行为测试兜底，删合法收窄会编译失败，风险
 * 有界）、无表达式模板字面量（`fill` 是 TemplateLiteral 节点，
 * isStringLiteral 不捕获，刻意构造才可触发）、扩展名盲区（收集正则
 * \.[cm]?tsx?$ 不扫 .js/.jsx/.mjs——当前双端 src 零此类文件，TS strict
 * 下新增亦不现实，仍声明）。packages/*（contract/grading 中央登记与
 * 判分绑定，§6.3 A）与 dsl-kit 不在 §11.2 规定的扫描范围。守护不能替代
 * 消费者验收（§10.1 表）。
 *
 * 白名单基线（下方 I16_BASELINE）：条目 = 文件 + 规范化片段 + 次数
 * （多重集合，与行号无关——上方插入代码不会误报）；既有分支被删除时
 * 同样失败，迫使清理时同步收窄基线。条目来源：A-D 组源自决策记录 §6.3
 * 基线表；E 组对话框态并非全部在册——仅两文件直接对应 §6.3 D，其余为
 * 执行时确认的合法分支，出处逐条见 E 组注释。新增合法分支的唯一路径：
 * 中央调度边界 / 绑定 / 参考格式化（§6.3 A）扩项时更新基线并在决策
 * 记录登记理由。
 */

/** 答案 kind 字面量（StudentAnswer 八 kind——TT-05a 域②扩容 response/matching/ordering） */
const ANSWER_KIND_LITERALS = new Set([
  "judge",
  "choice",
  "multi",
  "fill",
  "final",
  "response",
  "matching",
  "ordering",
] as const);
/** 题型字面量（QuestionType 十型——TT-05a 域②扩容，旧七型 + 新三型） */
const QUESTION_TYPE_LITERALS = new Set([
  "judge",
  "choice",
  "multi",
  "fill",
  "solve",
  "apply",
  "find-error",
  "response",
  "matching",
  "ordering",
] as const);
/** 守护判别集合：两集合并（kind 与 type 混用比较同样可疑，一并捕获） */
const KIND_LITERALS = new Set<string>([
  ...ANSWER_KIND_LITERALS,
  ...QUESTION_TYPE_LITERALS,
]);
/** 判别属性名（.kind / .type） */
const DISCRIMINANT_NAMES = new Set(["kind", "type"]);
/** 比较运算符（含非严格形式，TS strict 下应为 ===/!==） */
const COMPARE_OPS = new Set(["===", "!==", "==", "!="]);

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 语法树节点属性访问（滚轴轮转安全读取） */
function childOf(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return value !== null &&
    typeof value === "object" &&
    "type" in (value as object)
    ? (value as AstNode)
    : undefined;
}
function childrenOf(node: AstNode): readonly AstNode[] {
  const out: AstNode[] = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object" && "type" in item) {
          out.push(item as AstNode);
        }
      }
    } else if (value !== null && typeof value === "object" && "type" in value) {
      out.push(value as AstNode);
    }
  }
  return out;
}

function isStringLiteral(
  node: AstNode | undefined,
  texts?: Set<string>,
): node is AstNode {
  return (
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    (texts === undefined || texts.has(node.value))
  );
}

/** 标识符别名：kind/type 本名或其 camelCase 别名（answerKind、questionType…） */
function isKindOrTypeIdentifierName(name: string): boolean {
  return (
    name === "kind" ||
    name === "type" ||
    /[Kk]ind$/.test(name) ||
    /[Tt]ype$/.test(name)
  );
}

/** `.kind` / `.type` 属性访问（含可选链与计算访问 x["kind"]），或 kind/type 别名标识符 */
function isKindOrTypeAccessor(node: AstNode | undefined): boolean {
  let current = node;
  // 可选链在 ESTree 里外包一层 ChainExpression（q?.type → ChainExpression[MemberExpression]）
  if (current?.type === "ChainExpression") {
    current = childOf(current, "expression");
  }
  if (current === undefined) return false;
  if (current.type === "MemberExpression") {
    const property = childOf(current, "property");
    if (current.computed === true) {
      return isStringLiteral(property, DISCRIMINANT_NAMES);
    }
    return (
      property?.type === "Identifier" &&
      typeof property.name === "string" &&
      DISCRIMINANT_NAMES.has(property.name)
    );
  }
  return (
    current.type === "Identifier" &&
    typeof current.name === "string" &&
    isKindOrTypeIdentifierName(current.name)
  );
}

/** 一次命中：文件（仓库相对路径）+ 规范化片段 */
interface Hit {
  readonly file: string;
  readonly snippet: string;
}

/** 扫描单份源码：返回全部 kind 字面量判别命中（片段为源码切片、空白折叠） */
function scanSource(file: string, source: string): readonly Hit[] {
  const ast = parseAst(source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const hits: Hit[] = [];
  const record = (node: AstNode) => {
    const start = typeof node.start === "number" ? node.start : 0;
    const end = typeof node.end === "number" ? node.end : source.length;
    const snippet = source.slice(start, end).replace(/\s+/g, " ").trim();
    hits.push({ file, snippet });
  };
  const visit = (node: AstNode): void => {
    if (node.type === "BinaryExpression") {
      const op = typeof node.operator === "string" ? node.operator : "";
      if (COMPARE_OPS.has(op)) {
        const left = childOf(node, "left");
        const right = childOf(node, "right");
        const literalSide = isStringLiteral(left, KIND_LITERALS) ? left : right;
        const otherSide = literalSide === left ? right : left;
        if (
          literalSide !== undefined &&
          isStringLiteral(literalSide, KIND_LITERALS) &&
          isKindOrTypeAccessor(otherSide)
        ) {
          record(node);
        }
      }
    } else if (node.type === "SwitchStatement") {
      if (isKindOrTypeAccessor(childOf(node, "discriminant"))) {
        for (const clause of childrenOf(node)) {
          if (clause.type === "SwitchCase") {
            const test = childOf(clause, "test");
            if (isStringLiteral(test, KIND_LITERALS)) {
              // 只记 case 子句头（case "X":），不含子句体
              hits.push({
                file,
                snippet: `case ${JSON.stringify(test.value as string)}:`,
              });
            }
          }
        }
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };
  // rollup Program 节点与本文件宽松 AstNode 的结构边界：运行时同形（都按
  // type/children 遍历），类型系统无法直接断言重叠，经 unknown 一次
  visit(ast as unknown as AstNode);
  return hits;
}

// ---------- 文件收集（生产源码，排除测试/夹具/生成产物） ----------

/** 排除的目录名（相对路径任意层级命中即排除） */
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "test",
  "__tests__",
  "__mocks__",
  "fixtures",
  "generated",
  "coverage",
  "test-support",
  "dsl-kit",
]);

function isExcludedPath(relativePath: string): boolean {
  if (/\.test\.[cm]?[jt]sx?$/.test(relativePath)) return true;
  if (/\.spec\.[cm]?[jt]sx?$/.test(relativePath)) return true;
  if (/\.d\.ts$/.test(relativePath)) return true;
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIR_NAMES.has(segment));
}

/** 从 cwd 上溯找仓库根（包含 apps/web/package.json 的目录） */
function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      statSync(join(dir, "apps", "web", "package.json"));
      return dir;
    } catch {
      dir = join(dir, "..");
    }
  }
  throw new Error(`找不到仓库根（cwd=${process.cwd()}）`);
}

function collectSourceFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    if (isExcludedPath(relative)) continue;
    if (entry.isDirectory()) {
      collectSourceFiles(root, full, out);
    } else if (/\.[cm]?tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** 扫描 apps/web/src 与 apps/server/src 全部生产源码 */
function scanProductionSources(): readonly Hit[] {
  const root = repoRoot();
  const files: string[] = [];
  for (const app of ["apps/web/src", "apps/server/src"]) {
    collectSourceFiles(root, join(root, app), files);
  }
  const hits: Hit[] = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    hits.push(...scanSource(relative, readFileSync(file, "utf-8")));
  }
  return hits;
}

// ---------- 白名单基线（A-D 组源自 §6.3；E 组出处见组内注释） ----------

interface BaselineEntry {
  /** 仓库相对路径（正斜杠） */
  readonly file: string;
  /** 规范化片段（空白折叠；case 子句记录 case 子句切片） */
  readonly snippet: string;
  /** 该片段在本文件的既有出现次数（多重集合计数） */
  readonly count: number;
}

/**
 * A. 呈现登记表唯一调度边界：answering/index.tsx 四个显式 switch
 * （dispatchInput / dispatchReadOnly / dispatchComparison /
 * dispatchCompletion）+ assertNever 收尾，是 §4.4 允许的中央扩展点；
 * 窄化三元是 switch case 臂内把联合 answer 收窄到该 kind 视图的传参。
 */
const DISPATCH_INDEX_CASES: readonly BaselineEntry[] = (
  ["judge", "choice", "multi", "fill", "final"] as const
).map((literal) => ({
  file: "apps/web/src/features/answering/index.tsx",
  snippet: `case "${literal}":`,
  count: 4,
}));
const DISPATCH_INDEX_NARROW: readonly BaselineEntry[] = [
  ...(["judge", "choice", "multi", "fill"] as const).map((literal) => ({
    file: "apps/web/src/features/answering/index.tsx",
    snippet: `answer?.kind === "${literal}"`,
    count: 4, // Input/ReadOnly/Comparison/Completion 四调度臂内收窄
  })),
  {
    file: "apps/web/src/features/answering/index.tsx",
    snippet: 'answer?.kind === "final"',
    count: 3, // final 的 Input 臂只渲染题干（§10 final 不重复），无收窄
  },
];

/**
 * B. 准备层唯一分发边界：prepare-question 按 questionBindings 的
 * answerKind 中央 switch 逐形态白名单构造 PreparedQuestion（§8.1-2）。
 * TT-05a 域②扩容 response/matching/ordering 三 case：编译期穷尽补齐的显式
 * throw 守卫（呈现模型留 TT-08，方案 §7.1 缺模式明确报错）——决策记录
 * §12 TT-05a 登记理由。
 */
const PREPARE_CASES: readonly BaselineEntry[] = (
  [
    "judge",
    "choice",
    "multi",
    "fill",
    "final",
    "response",
    "matching",
    "ordering",
  ] as const
).map((literal) => ({
  file: "apps/web/src/features/answering/prepare-question.ts",
  snippet: `case "${literal}":`,
  count: 1,
}));

/**
 * C. choice/multi 视图内选项集合提取单源：optionPickedOf /
 * optionCorrectOf 是三宿主（ResultOptions / DetailOptions /
 * WrongOptions）共用实现（§9.2 调整 10），对联合答案/参考做收窄是
 * 其职责本体，属登记表项内部、不是散落在业务宿主的分支。
 */
const CHOICE_VIEW_NARROW: readonly BaselineEntry[] = [
  {
    file: "apps/web/src/features/answering/views/choice.tsx",
    snippet: 'answer.kind === "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/answering/views/choice.tsx",
    snippet: 'answer.kind === "multi"',
    count: 1,
  },
  {
    file: "apps/web/src/features/answering/views/choice.tsx",
    snippet: 'answers.kind === "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/answering/views/choice.tsx",
    snippet: 'answers.kind === "multi"',
    count: 1,
  },
];

/**
 * D. final 输入宿主最小收窄：HandwrittenControls 两处 FinalAnswerField
 * 挂点把联合答案收窄到 final 后交给呈现层（§6.3 B 末行——UA-03 消费
 * final 呈现后保留的宿主侧最小收窄；纸面控制器所有权不变）。
 */
const HANDWRITTEN_FINAL_NARROW: readonly BaselineEntry[] = [
  {
    file: "apps/web/src/features/attempt/HandwrittenControls.tsx",
    snippet: 'answer?.kind === "final"',
    count: 2,
  },
];

/**
 * E. 对话框态（非答案 kind）：草稿同步与提交证据确认的状态机用
 * kind="choice" 表示「让学生选择如何继续」的对话框语义——守护按字面量
 * 保守捕获，白名单理由即其非答案 kind 的澄清；「choice」误伤实例正是
 * §11.2 要求 AST 判别而不能裸文本匹配的原因之一。
 * 出处如实说明（§6.3 D 只点名 PracticeQuestionSubmit 与
 * LessonQuestionCard 两文件，非四文件）：PracticeQuestionSubmit ×2、
 * LessonQuestionCard ×2 直接对应 §6.3 D 在册分支；AttemptSession
 * notePrep 是 §9.3.7 轻量守护校准记载的对话框态；
 * use-submit-evidence-confirm ×3 是该状态机经 8ec59d5b「证据确认状态机
 * 单源」从 PracticeQuestionSubmit 抽出的单源落点（决策记录此前无此
 * 文件名），执行时逐条亲核为 idle/preparing/choice/error 对话框态联合
 * 后如实收录——非 §6.3 表内既有行。
 */
const DIALOG_STATE_NARROW: readonly BaselineEntry[] = [
  {
    file: "apps/web/src/features/attempt/AttemptSession.tsx",
    snippet: 'notePrep.kind === "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/attempt/PracticeQuestionSubmit.tsx",
    snippet: 'phase.kind === "choice"',
    count: 2,
  },
  {
    file: "apps/web/src/features/attempt/use-submit-evidence-confirm.ts",
    snippet: 'prev.kind === "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/attempt/use-submit-evidence-confirm.ts",
    snippet: 'current.kind !== "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/attempt/use-submit-evidence-confirm.ts",
    snippet: 'phase.kind !== "choice"',
    count: 1,
  },
  {
    file: "apps/web/src/features/lesson/LessonQuestionCard.tsx",
    snippet: 'phase.kind === "choice"',
    count: 2,
  },
];

/** 基线全集（§6.3 A 的 contract/grading 中央触点在 packages/，扫描范围外） */
const I16_BASELINE: readonly BaselineEntry[] = [
  ...DISPATCH_INDEX_CASES,
  ...DISPATCH_INDEX_NARROW,
  ...PREPARE_CASES,
  ...CHOICE_VIEW_NARROW,
  ...HANDWRITTEN_FINAL_NARROW,
  ...DIALOG_STATE_NARROW,
];

/** 多重集合比较键：file ␟ snippet */
const keyOf = (entry: { file: string; snippet: string }): string =>
  `${entry.file} ␟ ${entry.snippet}`;

/** 命中多重集合 vs 基线多重集合的差集报告 */
function diffAgainstBaseline(hits: readonly Hit[]): string {
  const found = new Map<string, number>();
  for (const hit of hits) {
    found.set(keyOf(hit), (found.get(keyOf(hit)) ?? 0) + 1);
  }
  const allowed = new Map<
    string,
    { count: number; file: string; snippet: string }
  >();
  for (const entry of I16_BASELINE) {
    allowed.set(keyOf(entry), { ...entry });
  }
  const problems: string[] = [];
  for (const [key, count] of found) {
    const base = allowed.get(key);
    if (base === undefined) {
      problems.push(`新增未授权分支：${key} ×${count}`);
    } else if (count > base.count) {
      problems.push(
        `分支次数超出基线：${key} 命中 ${count} 次 > 基线 ${base.count} 次`,
      );
    }
  }
  for (const [key, base] of allowed) {
    const count = found.get(key) ?? 0;
    if (count < base.count) {
      problems.push(
        `基线条目已减少（请同步收窄白名单并记录理由）：${key} 命中 ${count} 次 < 基线 ${base.count} 次`,
      );
    }
  }
  return problems.join("\n");
}

// ---------- 守护正文 ----------

describe("I16 全量 AST 守护（§11.2）", () => {
  it("生产源码无白名单外的答案 kind/题型字面量判别分支", () => {
    const problems = diffAgainstBaseline(scanProductionSources());
    expect(
      problems,
      `${problems}\n—— 新增分支须收进中央调度边界/绑定/参考格式化，或更新基线并在决策记录登记理由`,
    ).toBe("");
  });

  it.each([
    // 期望命中的形态
    [
      "if 比较",
      'if (answer.kind === "fill") doIt();',
      ['answer.kind === "fill"'],
    ],
    [
      "可选链三元",
      'const x = q?.type === "solve" ? 1 : 2;',
      ['q?.type === "solve"'],
    ],
    [
      "非严格不等",
      'if (answer.kind != "final") doIt();',
      ['answer.kind != "final"'],
    ],
    ["字面量在左", 'const ok = "fill" === x.kind;', ['"fill" === x.kind']],
    [
      "计算访问",
      'if (x["type"] !== "solve") doIt();',
      ['x["type"] !== "solve"'],
    ],
    [
      "裸标识符（解构别名）",
      'const { kind } = answer; if (kind === "fill") doIt();',
      ['kind === "fill"'],
    ],
    [
      "camelCase 别名标识符",
      'if (questionType === "solve") doIt();',
      ['questionType === "solve"'],
    ],
    [
      "switch case（判别式 .kind）",
      'switch (model.kind) { case "multi": break; default: break; }',
      ['case "multi":'],
    ],
    [
      "switch case（判别式 .type）",
      'switch (question.type) { case "apply": break; default: break; }',
      ['case "apply":'],
    ],
    [
      "switch case（判别式别名标识符 answerKind）",
      'const { answerKind } = b; switch (answerKind) { case "fill": break; default: break; }',
      ['case "fill":'],
    ],
    // 期望不命中的形态（其他领域字面量 / 非判别式）
    ["其他领域 kind 字面量", 'if (event.kind === "pointerdown") doIt();', []],
    [
      "讲练块类型字面量",
      'switch (block.type) { case "md": break; default: break; }',
      [],
    ],
    [
      "笔迹工具字面量",
      'switch (tool.type) { case "pen": break; case "eraser": break; }',
      [],
    ],
    ["非 kind/type 属性", 'if (binding.paperRole === "answerInk") doIt();', []],
    [
      "switch 判别式非 .kind/.type",
      'switch (mode) { case "judge": break; default: break; }',
      [],
    ],
    [
      "case 字面量不在集合",
      'switch (model.kind) { case "cloze": break; default: break; }',
      [],
    ],
    // AST 免疫裸文本误伤（§11.2 明文要求）
    [
      "字符串内容不误报",
      "const hint = 'if (x.kind === \"fill\") 请勿匹配';",
      [],
    ],
    ["注释内容不误报", '// if (x.kind === "fill") 请勿匹配\nconst a = 1;', []],
    ["类字符串属性不误报", 'const cls = "kind === judge";', []],
  ])("扫描器自检：%s", (_name, source, expected) => {
    const hits = scanSource("self-check.ts", source as string);
    expect(hits.map((hit) => hit.snippet)).toEqual(expected);
  });
});
